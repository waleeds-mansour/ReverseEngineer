# Spec 8 — Calendar providers: Google becomes one adapter · DESIGN ONLY (do not build yet)

> **Source / provenance:** Hearth's own calendar code, read at `ad375e65`, plus the providers'
> public specifications and docs: CalDAV (RFC 4791), WebDAV sync (RFC 6578), CalDAV scheduling
> (RFC 6638), CalDAV discovery (RFC 6764), iCalendar (RFC 5545), Microsoft Graph's calendar and
> identity-platform docs, and Google Calendar's API docs. It doesn't come from dots or Grok Bot,
> and nothing here is reverse-engineered from another app. The libraries named below were checked
> for their licence only. No code is adapted from them. The Morgen research ([../morgen.md](../morgen.md)
> §1) asks for the same interface. This spec was written from the code without depending on it,
> and it differs on one point: which adapter comes second (decision 1). It's the calendar twin of
> D15's planned `MailProvider` (`docs/decisions.md:161-167`).

## The gap today
Hearth's calendar is Google Calendar from end to end. The model Hearth keeps (an `event` entity
plus its `calendar_event` row) has nothing Google-specific in it. Everything that fills it, writes
it or judges its health does. A sync starts by taking the Google client:
```ts
// packages/modules/src/calendar/sync.ts:63-67
export async function syncCalendars(ctx: ActionContext): Promise<SyncResult> {
  const google = ctx.service<GoogleClient>(GOOGLE_SERVICE);
  const api = new CalendarApi(google, ctx.tx);
  const rules = await getSetting(ctx.tx, "owner.dayRules");
  const { from, to } = syncWindow(ctx.now, rules.timeZone);
```
The task brief names a `writes.ts`, but there's no such file. Writes to your own events live in
`actions.ts` and writes to meetings in `meetings.ts`, and `writes.test.ts` tests both. Where Google
is wired in:

| Where (`packages/modules/src/…`) | What's Google-only |
|---|---|
| `calendar/sync.ts:68-78` | Accounts are `google_account` rows holding the calendar scope. |
| `calendar/sync.ts:124`, `google/calendar-api.ts:126-147` | Each round lists the whole window (7 days back, 60 ahead, `sync.ts:22-23`) with `singleEvents=true`. That's a snapshot every time, with no cursor. |
| `calendar/sync.ts:172-198` | Whatever is in the window but no longer listed is marked cancelled. |
| `calendar/sync.ts:52-60` | A time block is recognised by `extendedProperties.private.hearthTask`. |
| `calendar/store.ts:111-151` | `mapEvent` turns a `GEvent` straight into Hearth's `Mapped` row. |
| `calendar/series.ts:16-17` | `seriesOf` strips the `_R<date>` suffix Google adds when a series is split. |
| `calendar/calendars.ts:76-116` | `syncCalendarList` reads Google's calendar list. `canWrite` comes from `accessRole` (`:85`), and a calendar is synced by default if you own it (`:106`). |
| `calendar/calendars.ts:26` | "Your own calendar" means `google_account.email = calendar.google_id`. That's read by `isOwnCalendar` (`:29-37`), `calendar.events` (`index.ts:145`), `soon.ts:54-59` and `mail/invites.ts:112`. |
| `calendar/calendars.ts:122-149` | `writableCalendar` joins `google_account`. Its error is "No Google Calendar is connected" (`:141-147`). |
| `calendar/actions.ts:34-36` | `api(ctx)` is a `CalendarApi`. `insertEvent` (`:75-102`), `patchEvent` (`:122-145`) and `removeEvent` (`:147-158`) build `GEvent` bodies and Google's `sendUpdates`. |
| `calendar/respond.ts:94-103` | Answering an invitation means reading Google's guest list, changing only your own `responseStatus`, and patching it back with `sendUpdates=all`. |
| `calendar/health.ts:17-25` | `troubleOf` reads `GoogleApiError` kinds. Health is kept on `google_account` (`db/src/schema/google.ts:31-38`). |
| `google/client.ts:28-35`, `:140-250` | OAuth with PKCE through a loopback redirect, and the scopes. Tokens are sealed with the vault (`client.ts:226-235`, `secrets.ts:21-28`). |
| `apps/worker/src/worker.ts:93-113` | Every five minutes it runs `calendar.sync`, but only if a `google_account` row exists. |

**What's already provider-free, and stays exactly as it is:**
- **The canonical model.** That's `Mapped` (`store.ts:106-109`), `saveEvent` (`store.ts:235-290`),
  `emitChange` (`store.ts:292-309`) and the one `calendar.event_changed` event (`index.ts:80-84`).
  It holds one row per occurrence, and `recurringEventId` names the series.
- **Your own free time.** It's Hearth's arithmetic over the rows it has synced: `busyTimes`
  (`free.ts:17-41`) and `freeSlots` (`free.ts:78-91`). Hearth never asks Google for free/busy.
- **Everything that reads rows.** That's the invitation card (`invites.ts:99-139`), overlap
  notices, prep packets, heads-ups and the digest.
- **Echo suppression.** It has three parts, and none of them needs Google:
  1. After every write, `save()` (`actions.ts:47-59`) maps the provider's reply and stores it at
     once. So `calendar.event_changed` fires once, for the write.
  2. The next sync brings the same event back. `saveEvent` sees the same `etag` and reports no
     change (`store.ts:255-263`). Even when the etag differs, a change is reported only if the
     time, status or title moved (`store.ts:264-277`).
  3. A create retried after a lost reply finds the event it already made. Its id is a hash of what
     the event is (`calendar-api.ts:67-69`, `:174-191`, D61). A time block carries `hearthTask`, so
     a sync claims it even if Hearth never saved it (`writes.test.ts:70-88`).

## Design: one `CalendarProvider` interface, then an adapter per provider
Four pieces. The interface comes first, then Google behind it with no change in behaviour, then
Microsoft Graph and CalDAV as their own adapters.

### 1. The interface
```ts
// packages/modules/src/calendar/provider.ts (new)
export type ProviderKind = "google" | "microsoft" | "caldav";

/** What one provider can do. The core checks these before it calls, and says plainly when it can't. */
export interface ProviderCaps {
  invites: boolean;  // writing guests onto an event sends them invitations, updates and cancellations
  rsvp: boolean;     // answering an invitation sends the organizer your answer
  freeBusy: boolean; // other people's busy times (yours always come from Hearth's own rows)
}

export interface ProviderCalendar {
  providerId: string;      // kept in calendar.google_id
  title: string; color: string | null; timeZone: string | null;
  isPrimary: boolean; canWrite: boolean;
  own: boolean;            // its invitations are yours to answer
  syncByDefault: boolean;  // today: you own it
}

/** One occurrence as Hearth keeps it, plus Hearth's own mark on a time block. */
export interface ProviderEvent { mapped: Mapped; taskId?: string }

/** A sync answers in one of two shapes. The cursor is opaque: only the adapter reads it. */
export type SyncPage =
  | { kind: "snapshot"; events: ProviderEvent[]; cursor: string | null } // all of the window; what's missing is gone
  | { kind: "delta"; events: ProviderEvent[]; removed: string[]; cursor: string }; // only what changed

export interface EventDraft {
  title: string; start: string; end: string; description?: string; location?: string;
  attendees?: string[]; taskId?: string;
}
export type EventPatch = Partial<Pick<EventDraft, "title" | "start" | "end" | "description" | "location">>;

export interface CalendarProvider {
  readonly kind: ProviderKind;
  readonly caps: ProviderCaps;
  calendars(account: string): Promise<ProviderCalendar[]>;
  sync(account: string, cal: CalendarRow, window: { from: Date; to: Date },
       cursor: string | null, tz: string): Promise<SyncPage>;
  get(account: string, cal: CalendarRow, eventId: string, tz: string): Promise<ProviderEvent | null>;
  /** Creates once (D61): a retry after a lost reply finds the event it already made. */
  insertOnce(account: string, cal: CalendarRow, draft: EventDraft, notify: boolean, tz: string): Promise<ProviderEvent>;
  patch(account: string, cal: CalendarRow, eventId: string, patch: EventPatch, notify: boolean, tz: string): Promise<ProviderEvent>;
  remove(account: string, cal: CalendarRow, eventId: string, notify: boolean): Promise<void>;
  /** Changes only your own answer. `eventId` is the occurrence ("this") or the series ("all"). */
  respond(account: string, cal: CalendarRow, eventId: string,
          answer: "accepted" | "declined" | "tentative", tz: string): Promise<ProviderEvent | null>;
  freeBusy?(account: string, addresses: string[], from: Date, to: Date): Promise<Map<string, Slot[]>>;
  /** The key that ties a split series back together (series.ts). The default is the id itself. */
  seriesKey?(recurringEventId: string): string;
}
```
Adapters throw one `ProviderError` with the kinds `GoogleApiError` already has: `rate_limited`,
`paced`, `auth`, `transient`, `not_found` and `refused` (`google/errors.ts:3-17`). Then `slowDown`
and `notFound` (`sync.ts:36-37`) and `troubleOf` (`health.ts:17-25`) read it the same way for every
provider. `GoogleApiError` becomes a subclass, so nothing that catches it today changes.

### 2. Sync: one loop, two shapes of answer
`syncCalendars` keeps its shape (`sync.ts:63-212`): per account, per selected calendar, one
savepoint per event, then health per account. The one change is that it asks the calendar's
adapter (`providerFor(cal)`) instead of `CalendarApi`.
- **A snapshot** is everything in the window, and the core handles it exactly as today. Series
  takeovers run first (`series.ts:24-91`), then each event is saved, then whatever wasn't listed
  is marked cancelled (`sync.ts:172-198`).
- **A delta** is only what changed since the cursor. Each event is saved. Each id in `removed` is
  marked cancelled; an id can match one occurrence, or a series, which takes every occurrence of
  it. Series takeovers look only at the rows the delta removed. Without that, everything a delta
  didn't mention would look gone.
- **The cursor** is stored in a new `calendar.sync_cursor`, in the same transaction as the rows.
  A round that fails keeps the old cursor, and the next round repeats it. Repeats are harmless,
  because `saveEvent` and the etag check make saving the same event twice a no-op.
- **The adapter decides** when it can't answer with a delta: there's no cursor, the token has
  expired, or the window has moved past the one the cursor was made for. In those cases it answers
  with a snapshot. The core never looks inside a cursor.

### 3. Writes, invitations and free/busy
- **Every check stays where it is.** The actions keep `editable` (`actions.ts:104-120`),
  `ownCalendar` (`actions.ts:66-73`), the approval snapshots (`meetings.ts:51-70`) and
  `mustBeYours` (`respond.ts:35-41`). They call `providerFor(cal)` where they call `api(ctx)` today.
  `notify` replaces `SendUpdates`, and it's true exactly where Hearth passes `"all"` today
  (`actions.ts:99`, `:142`, `:149`; `respond.ts:103`).
- **`caps` gates.** A calendar whose provider can't send invitations makes
  `calendar.schedule_meeting`, `calendar.update_meeting` and `calendar.cancel_meeting` fail plainly
  before anything is written: "this calendar can't invite people from Nook". A calendar that can't
  send answers does the same for `calendar.respond`. The `calendar.new_invite` reflex
  (`invites.ts:99-139`) skips those calendars, so no card offers what can't be done.
- **`respond`** returns the occurrence as the provider now has it. For "every time", `respond.ts`
  keeps `answerSeries` (`respond.ts:17-32`).
- **Free/busy.** Yours stays local (`free.ts`). `freeBusy` on the interface is only for other
  people's time, and no action asks for that today. It's optional and read-risk, and v1 adapters
  may leave it out. The sources would be Graph's `getSchedule`, RFC 6638 §5 (a POST to the
  schedule outbox), or Google's `freebusy.query`.

### 4. Google moves behind it, with no change in behaviour
- **The adapter wraps what's there.** `GoogleProvider` wraps `CalendarApi`
  (`calendar-api.ts:99-224`) unchanged. `mapEvent` (`store.ts:111-151`) moves in as its mapper and
  `seriesOf` (`series.ts:16-17`) becomes its `seriesKey`. `respond` is today's
  read-the-guest-list-then-patch, moved inside (`respond.ts:95-103`). `insertOnce` is today's,
  with `hearthTask` set from `draft.taskId` (`actions.ts:97`).
- **Sync stays a snapshot with no cursor.** It's the same `events()` call over the same window.
  Google's own incremental sync would lose the window: its `syncToken` can't be combined with
  `timeMin` or `timeMax`, and an expired token returns 410, which means a full sync (Events: list
  reference; Calendar sync guide). Moving Google to `syncToken` later is a change inside the
  adapter, not in the core.
- **"Own" keeps today's join** (`calendars.ts:26`), so a calendar of another connected Google
  account still counts as yours. Other providers set `calendar.own` when they list calendars.
  `isOwnCalendar` becomes "`own` is set, or today's join matches".
- **Proof: the tests don't change.** `sync`, `series`, `writes`, `respond`, `accounts`,
  `meetings`, `conflicts`, `brief` and `prep` (`calendar/*.test.ts`) and `mail/invites.test.ts`
  pass as they are, against `FakeGoogle` (`google/fake.ts`). A new provider conformance suite runs
  the same scenarios against each adapter's fake: create once, edit, cancel, answer this time and
  every time, a series split, and a delta after a snapshot.
- **One additive migration.** It adds `calendar.provider text not null default 'google'`,
  `calendar.sync_cursor text` and `calendar.own boolean not null default false`. The unique key
  becomes `(provider, account, google_id)`, and `handOver` and `calendar.choose` match on
  `provider` too (`calendars.ts:55-73`, `:193-207`). The `google_id` columns keep their names, the
  way `hearth` and `jarvis` do, with a comment saying they hold the provider's id.

### 5. Microsoft Graph adapter (Outlook.com, Microsoft 365)
| | |
|---|---|
| **Auth** | The Microsoft identity platform's auth-code flow with PKCE, a public desktop client and an `http://localhost` redirect, the way Google's sign-in works (`routes/google.ts:17-60`). Scopes are `Calendars.ReadWrite` and `offline_access`; a refresh token comes only with `offline_access`. A refresh may return a new refresh token, which replaces the old one. |
| **Calendars** | `GET /me/calendars`. `own` means `isSharedWithMe` is false and `owner` is the account's address. `canWrite` is `canEdit`, and `isPrimary` is `isDefaultCalendar`. |
| **Incremental sync** | The primary calendar uses `GET /me/calendarView/delta?startDateTime&endDateTime`. The whole `@odata.deltaLink` is the cursor, and the window is fixed into it, so the adapter starts a new round (a snapshot) when the window's start moves, about once a day. A `410 Gone`, or an error such as `syncStateNotFound`, also means a snapshot. Removed events come under `@removed`, and so do events outside the window that changed: both go in `removed`. Replays can happen, and the etag check absorbs them. In v1.0, delta is documented for the primary calendar only, so other calendars are snapshots of `GET /me/calendars/{id}/calendarView` each round. |
| **Recurrence** | `calendarView` returns the occurrences, exceptions and single events in the window, never series masters. `type` says which, and `seriesMasterId` becomes `recurringEventId`. Graph expands the series itself, as Google does with `singleEvents=true`. |
| **Ids and versions** | Every call sends `Prefer: IdType="ImmutableId"`. Without it, an event's id changes when it moves between calendars. `@odata.etag` goes in `calendar_event.etag`. Times are asked for in UTC (`Prefer: outlook.timezone`). All-day events (`isAllDay`) become local dates, as Google's `date` does (`store.ts:113-117`). |
| **Writes** | `POST /me/calendars/{id}/events`, `PATCH /me/events/{id}`, `DELETE /me/events/{id}`. Graph has no "don't notify" switch: a meeting's update tells its guests, and deleting it from the organizer's calendar sends them a cancellation. That's safe because Hearth changes events that have guests only through outward actions (`actions.ts:104-120`). |
| **Create once** | Graph's `transactionId` exists to stop duplicate creates on client retries. It's set to the same hash Google's event id uses (`calendar-api.ts:67-69`). `hearthTask` goes in a single-value extended property. |
| **RSVP** | `POST /me/events/{id}/accept`, `/decline` or `/tentativelyAccept` with `sendResponse: true`, on the occurrence id ("this") or on `seriesMasterId` ("all"). The reply is `202` with no body, so the adapter reads the event back before Hearth saves it. |
| **Free/busy** | `POST /me/calendar/getSchedule`, but only for work and school accounts: it's not supported for personal Microsoft accounts. |
| **Limits** | Outlook allows 10,000 requests per 10 minutes and four at a time, per app per mailbox. A `429` with `Retry-After` becomes `rate_limited`. |
| **Mapping** | `showAs` of `free` or `workingElsewhere` means not busy, and `oof` means kind `outOfOffice`, so `NOT_MEETINGS` (`store.ts:32`) keeps working. `isOrganizer` sets `selfOrganizer`, and `responseStatus` sets `selfResponse`. `self` is the attendee whose address is the account's. The body may be HTML and is stored as text. `iCalUId` differs for each occurrence, so a series that's also on a Google calendar can count as two meetings for `soon.ts:40-63`. That's a known gap, fixable later by reading the series master's id. |

### 6. CalDAV adapter (iCloud, Fastmail, self-hosted)
| | |
|---|---|
| **Auth** | HTTP Basic over TLS only: RFC 4791 §11 forbids Basic without TLS. The password is an app-specific password the provider issues for one app. iCloud needs one (Apple account settings), and so does Fastmail, whose server is `caldav.fastmail.com`. |
| **Finding the calendars** | The owner gives a host or URL. The adapter tries `/.well-known/caldav`, which servers must redirect, or the SRV and TXT records (RFC 6764 §§3-6). Then `DAV:current-user-principal` (RFC 5397) leads to `CALDAV:calendar-home-set` (RFC 4791 §6.2.1), and a `PROPFIND` on the home lists the calendars. `own` means the calendar's `DAV:owner` is your principal. `canWrite` comes from `current-user-privilege-set`. A calendar must list `VEVENT` in `supported-calendar-component-set` (§5.2.3). |
| **Incremental sync** | `sync-collection` (RFC 6578 §3.2) wherever the collection lists it in `supported-report-set`. The `sync-token` is the cursor. Changed members come back as hrefs with etags, and removed ones with a 404 (§3.5). The changed ones are fetched with `calendar-multiget` (RFC 4791 §7.9). An invalid token (`DAV:valid-sync-token`) means a snapshot. A truncated answer (`507`, §3.6) is paged with the token it returned. `sync-collection` has no time range, so a series' instances entering the window don't show up as changes, and the adapter answers a snapshot once a day. Where there's no `sync-collection`, every round is a snapshot: `calendar-query` with a `time-range` (§7.4, §7.8). |
| **Recurrence** | One resource holds a series and its exceptions (RFC 4791 §4.1). Every read asks the server for `CALDAV:expand` over the window (§9.6.5). The server then returns one component per instance, in UTC, with no `RRULE` and no `VTIMEZONE`, and each instance after the first carries a `RECURRENCE-ID`. So in v1 Hearth never expands an `RRULE` itself. An instance's id is `<href>#<RECURRENCE-ID or DTSTART, in UTC>`, and `recurringEventId` is the href. If a server answers with an unexpanded `RRULE`, the calendar's `lastError` says so; Hearth doesn't guess. |
| **Ids and versions** | The resource's ETag goes in `calendar_event.etag`. Every instance of a series shares it, which is fine: when the etag differs, `saveEvent` still reports only what moved (`store.ts:264-277`). |
| **Writes** | `PUT` with `If-None-Match: *` to create and `If-Match` to change (RFC 4791 §5.3.2), and `DELETE` with `If-Match`. A server that changed what was sent returns no strong ETag (§5.3.4), so the adapter reads it back before Hearth saves it. |
| **Create once** | The resource name and `UID` are the same hash Google's event id uses, so a retried `PUT` with `If-None-Match: *` hits `412` and finds the one it made. `hearthTask` goes in an `X-HEARTH-TASK` property. |
| **Invitations and RSVP** | These work only where the server advertises `calendar-auto-schedule` (RFC 6638 §2). There, putting an event with `ATTENDEE`s sends `REQUEST`s and deleting it sends `CANCEL`s (§3.2.1). As an attendee, you change only your own `PARTSTAT` (§3.2.2.1) and the server sends the organizer your reply. "Every time" changes the series and its exceptions. "This time only" adds or edits the exception with that `RECURRENCE-ID` (RFC 5545 §3.8.4.4). That's the one place Hearth writes iCalendar structure, and it's guarded by `If-Schedule-Tag-Match` (§3.2.10). You are the attendee whose address is in your `calendar-user-address-set` (§2.4.1). Without `calendar-auto-schedule`, `caps.invites` and `caps.rsvp` are false (see "Writes, invitations and free/busy" above). |
| **Free/busy** | RFC 6638 §5 (a `VFREEBUSY` POST to the schedule outbox) where scheduling is supported, otherwise left out. |
| **Limits** | The RFCs set none. A `503` or `429` with `Retry-After` becomes `rate_limited`, and there's one round per five minutes, the same as now. |
| **Mapping** | `TRANSP:TRANSPARENT` means not busy (RFC 5545 §3.8.2.7). There are no event kinds like Google's, so `kind` is always `default`. A floating time is read in the owner's time zone. |

## New / changed surface
- **add** `calendar/provider.ts` (the interface and `ProviderError`), `calendar/providers.ts`
  (`providerFor(cal)` from kernel services, like `GOOGLE_SERVICE`, `client.ts:26`) and
  `google/calendar-provider.ts`. Later, `microsoft/` and `caldav/` folders, each with a client, a
  provider and a fake.
- **change** `sync.ts`, `actions.ts`, `respond.ts`, `calendars.ts` (the list sync,
  `writableCalendar`, and `handOver`/`choose` matching on provider), `health.ts`, `series.ts` and
  `invites.ts` (to skip calendars that can't answer).
- **change** the words Pip reads. "Google Calendar" becomes "your calendar" in action descriptions
  such as `calendar.sync` (`index.ts:212`) and `calendar.calendars` (`calendars.ts:155`). The
  action names don't change.
- **migration** (Phase 0) adds `calendar.provider`, `calendar.sync_cursor` and `calendar.own`.
  With the first non-Google adapter comes a `calendar_account` table: provider, account,
  `connected_at`, status, the sealed secret, and the same health columns `google_account` has
  (`schema/google.ts:31-38`). The five places that join `google_account` for a calendar
  (`calendars.ts:26`, `:60`, `:126`; `soon.ts:54-59`, `:73-78`) read both.
- **add** owner-only connect paths. For Microsoft, `/api/microsoft/connect` and `/callback` mirror
  `routes/google.ts`. For CalDAV, there's a `calendar.connect_caldav` action. Each emits
  `calendar.connected` (provider, account). There's also a `calendar.disconnect` for non-Google
  accounts; Google keeps `google.disconnect` (`disconnect.ts:138-153`).
- **change** the worker loop (`worker.ts:93-113`) to run when any calendar account exists, not
  just a Google one.
- **web**: Settings > Calendars lists the accounts by provider, with Connect Google, Connect
  Microsoft and Add a CalDAV calendar.

## Safety / privacy (unchanged rails)
**Each action's kernel risk stays the same whatever the provider.** Risk belongs to the action,
not the adapter, and no adapter can raise or lower it:

| Action | Risk (callers) | Where |
|---|---|---|
| `calendar.events`, `calendar.get`, `calendar.free_time`, `calendar.calendars` | `read` | `index.ts:136`, `:176`, `:195`; `calendars.ts:157` |
| `calendar.sync` | `internal` (owner, system, integration) | `index.ts:214-215` |
| `calendar.create_event` (no guests) | `internal` | `actions.ts:185` |
| `calendar.update_event`, `calendar.delete_event`, `calendar.block_task` | `self_external` | `actions.ts:204`, `:211`; `blocks.ts:133` |
| `calendar.schedule_meeting`, `update_meeting`, `cancel_meeting`, `calendar.respond` | `outward` | `meetings.ts:82`, `:106`, `:127`; `respond.ts:62` |
| `calendar.choose`, `calendar.set_default`, `google.disconnect`, new `calendar.disconnect` | `internal` (owner only) | `calendars.ts:186-187`, `:220-221`; `disconnect.ts:143-144` |
| new `calendar.connect_caldav` | `secret` (owner only) | like `notion.connect` (`notion/connect.ts:49-73`) |

Two provider behaviours lean on these rails, and both are covered:
- **Graph can't write a meeting quietly.** That's fine, because guest events change only through
  outward actions.
- **On CalDAV, guests are only told if the server schedules.** Without that, `caps` makes the
  outward actions refuse. Hearth never writes guests onto an event that would silently tell nobody.

**Where credentials live, and why Pip never sees them.**
- **Microsoft:** refresh and access tokens are sealed with the vault, as Google's are
  (`client.ts:226-235`, `secrets.ts:21-28`, D58). Each is labelled with its account and kind, so it
  can't be moved to another row.
- **CalDAV:** the app-specific password is sealed the same way and labelled
  `caldav <account> password`.
- **Only the clients open the secrets.** The provider clients are kernel services, and they're the
  only code that opens a sealed secret. No calendar action takes a credential as input.
- **Connecting is yours, from Settings.**
  - The OAuth routes check that the caller is you (`routes/google.ts:18-19`).
  - `calendar.connect_caldav` is `risk: "secret"` with `callers: ["owner"]`. The kernel refuses
    secret actions to Pip (`kernel/src/policy.ts:60`), hides them from its tools (`policy.ts:113`),
    and the audit log stores `{ redacted: true }` for their input (`kernel/src/audit.ts:81`).
  - Pip can't ask for a password in chat in a way that works: no action takes one.
- **The CalDAV address is yours, typed in Settings.** Discovery stays on `https`. The account is
  pinned to the host the well-known redirect lands on. A URL found in an event (a location, a
  description, an attachment) is never followed.
- **Outside content stays outside.** Someone else's invitation is still marked outside in the
  digest (`index.ts:258-259`), and the invitation card names the sender by address
  (`invites.ts:128-129`), whatever the provider.

**When a calendar is missing or signed out, Spec 4's Connect card covers it.** Spec 4 (in review)
adds `ConnectionError` and a card that opens Settings and picks the task back up on a
`<provider>.connected` event. Spec 8 adds `calendar` to its providers:
- **No calendar at all.** `writableCalendar`'s "No Google Calendar is connected"
  (`calendars.ts:141-147`) becomes a `ConnectionError("calendar", why)`. The card opens Settings >
  Calendars, where you pick Google, Microsoft or CalDAV. Pip says why it needs one, in its own
  words.
- **An account that's signed out.** A provider `auth` error during a turn's write becomes the same
  error, naming the account. Background syncs keep today's notice with how to reconnect
  (`index.ts:34-50`).
- **Picking the task back up.** `calendar.connected` (from the OAuth callback or
  `calendar.connect_caldav`) is what `connect.wait` waits for.

The card can't connect anything itself. Its link is a fixed Settings route.

## Decisions to settle before building
1. **Which adapter comes second, Microsoft or CalDAV?** We recommend **Microsoft Graph**. Its shape
   is closest to Google's: OAuth, JSON, the server expands recurrence, creates have an idempotency
   key, and RSVP is an endpoint. So it proves the interface with the least new risk, and the Graph
   client is the one Morgen §3's Microsoft To Do idea needs anyway. CalDAV comes third. The Morgen
   note puts CalDAV first, for reach (iCloud, Fastmail and self-hosted servers in one adapter).
   Swap them if the calendar you actually want is iCloud: the interface is the same either way.
2. **Which libraries may CalDAV use?** We recommend plain `fetch`, as Google's client does
   (`client.ts:2-3`), plus **`fast-xml-parser` (MIT)** for WebDAV's XML. iCalendar parsing extends
   Hearth's own reader (`mail/invites.ts:16-30`), and the server's `expand` means no `RRULE` engine
   is needed. `tsdav` (MIT) may be read for reference. **`ical.js` (MPL-2.0)** and **`rrule`
   (BSD-3-Clause)** aren't MIT, so they'd need your OK as dependencies. They're only needed if we
   later expand recurrence ourselves.
3. **Microsoft's app registration and tenant.** You register one public desktop app with an
   `http://localhost` redirect. Its client id goes in `.env`, like `HEARTH_GOOGLE_CLIENT_ID`. We
   recommend the `common` tenant, so personal and work accounts both work. A work tenant may still
   need its admin's consent.
4. **Where do non-Google accounts live?** We recommend one `calendar_account` table for Microsoft
   and CalDAV. `google_account` stays as it is, because Gmail shares its rows and tokens. The
   alternative, a table per provider, triples the joins.
5. **Polling or push?** We recommend **polling every five minutes**, as now. Graph change
   notifications and Google push both need a public HTTPS endpoint. That's possible behind the
   Funnel, but it's more surface for little gain on a personal calendar.
6. **Column names.** We recommend keeping `google_id` (with a comment), not renaming it to
   `provider_id`. The rename is churn across about 50 lines of code and a migration, and it buys
   nothing on screen.

## Risk / effort
- **Phase 0, Google behind the interface. Medium effort, low risk.** It's mostly moving code:
  `CalendarApi` and `mapEvent` behind `GoogleProvider`, `providerFor` in the four files that use
  `CalendarApi` today, and one additive migration. It's done when every calendar test passes
  unchanged. It ships alone and changes nothing you can see.
- **Phase 1, Microsoft Graph. Medium effort, medium risk.** That's a new OAuth client (most of
  `google/client.ts` and `tokens.ts` carry over), the adapter, a fake Graph, Settings, and the
  conformance suite. The risks are the delta round's fixed window, and recurring series shared with
  Google calendars counting twice in heads-ups.
- **Phase 2, CalDAV. Higher effort, medium-high risk.** That's XML, discovery, `sync-collection`
  plus the daily snapshot, writing an exception for "this time only", and servers that differ in
  what they support (`expand`, `sync-collection`, `calendar-auto-schedule`). The `caps` flags and a
  clear `lastError` contain it. A fake CalDAV server in tests gets a mode for each "doesn't
  support".
- **What it builds on.** It pairs with Spec 4 (the Connect card) and Spec 1 (writes from any
  provider show in the timeline the same way). Spec 7's day planner reads free time from Hearth's
  own rows (`free.ts`), so it works with any provider once Phase 0 lands. Spec 8 doesn't change
  Pip's behaviour, only where its calendar comes from.
