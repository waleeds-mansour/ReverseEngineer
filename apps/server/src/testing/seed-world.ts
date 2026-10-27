// What a seeded test server holds (seeded.ts): today on the calendar and a small inbox, put into
// the fake Google so Nook's own sync brings them in, and sorts the mail by its real rules. The
// end-to-end steps (apps/web/e2e/seeded.ts) find them by the names here.
import { addLocalDays, atLocal, DEFAULT_DAY_RULES } from "@hearth/core";
import type { FakeGoogle } from "@hearth/modules/google-testing";

export const ME = "owner@example.com";
/** The time zone the week is laid out in, and the test browser's: Nook's own default. */
export const SEED_TZ = DEFAULT_DAY_RULES.timeZone;

/** Today's events: Google ids, titles, and minutes after midnight. */
export const WEEK = {
  /** Yours, without guests: it saves when dropped. */
  own: { id: "dent1", title: "Dentist", from: 10 * 60, to: 11 * 60 },
  /** Yours, with two guests: dropping it asks before they're told. */
  meeting: {
    id: "plan1",
    title: "Planning review",
    from: 14 * 60,
    to: 15 * 60,
    guests: ["sam@work.example", "jo@work.example"],
  },
  /** Priya's, with you as a guest: only she can move it. */
  theirs: { id: "sync1", title: "Design sync", from: 17 * 60, to: 18 * 60 },
  allDay: { id: "conf1", title: "Conference" },
  /** Every day this week and around it, one time each. */
  repeating: { id: "standup", title: "Standup", from: 9 * 60, to: 9 * 60 + 15 },
} as const;

/** One of each kind of mail, sorted by the rules into People, Updates, Receipts and Newsletters. */
export const INBOX = {
  person: {
    subject: "Dinner on Saturday?",
    from: { name: "Ana Silva", address: "ana@friends.example" },
  },
  receipt: {
    subject: 'Your Amazon.com order of "Dune"',
    from: { name: "Amazon.com", address: "auto-confirm@amazon.com" },
  },
  shipping: {
    subject: "Your package is out for delivery",
    from: { name: "UPS", address: "pkginfo@ups.com" },
  },
  notice: {
    subject: "[acme/web] Fix invoice export (PR #42)",
    from: { name: "Sam Lee", address: "notifications@github.com" },
  },
  newsletter: {
    subject: "The week in tech",
    from: { name: "Stratechery", address: "news@stratechery.example" },
  },
} as const;

/** How many of the inbox each bundle holds. */
export const BUNDLE_COUNTS = { people: 1, updates: 2, receipts: 1, newsletters: 1 } as const;

const UPDATES = ["INBOX", "UNREAD", "CATEGORY_UPDATES"];
const PROMOTIONS = ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"];

/** Google's dateTime for `minute` past midnight on `day` where the week is. */
const at = (day: string, minute: number) => ({
  dateTime: atLocal(day, minute, SEED_TZ).toISOString(),
});

/** Puts today's events (`today` is "2026-10-27" where the week is) in your primary calendar. */
export function putWeek(g: FakeGoogle, today: string) {
  const self = { email: ME, self: true };
  const { own, meeting, theirs, allDay, repeating } = WEEK;
  g.put(ME, {
    id: own.id,
    summary: own.title,
    organizer: self,
    start: at(today, own.from),
    end: at(today, own.to),
  });
  g.put(ME, {
    id: meeting.id,
    summary: meeting.title,
    organizer: self,
    attendees: [
      { ...self, organizer: true, responseStatus: "accepted" as const },
      ...meeting.guests.map((email) => ({ email, responseStatus: "accepted" as const })),
    ],
    start: at(today, meeting.from),
    end: at(today, meeting.to),
  });
  const priya = "priya@work.example";
  g.put(ME, {
    id: theirs.id,
    summary: theirs.title,
    organizer: { email: priya },
    attendees: [
      { email: priya, organizer: true, responseStatus: "accepted" as const },
      { ...self, responseStatus: "accepted" as const },
    ],
    start: at(today, theirs.from),
    end: at(today, theirs.to),
  });
  g.put(ME, {
    id: allDay.id,
    summary: allDay.title,
    organizer: self,
    start: { date: today },
    end: { date: addLocalDays(today, 1) },
  });
  // A repeating event as Google lists it with singleEvents: a time each day, all of one series.
  for (let d = -7; d <= 7; d++) {
    const day = addLocalDays(today, d);
    const start = at(day, repeating.from);
    g.put(ME, {
      id: `${repeating.id}_${start.dateTime.replace(/[-:]|\.\d+/g, "")}`,
      recurringEventId: repeating.id,
      summary: repeating.title,
      organizer: self,
      start,
      end: at(day, repeating.to),
    });
  }
}

/** Delivers the inbox to your Gmail, a few minutes apart, the person's newest. */
export function deliverInbox(g: FakeGoogle) {
  const ago = (m: number) => new Date(Date.now() - m * 60_000);
  const { person, receipt, shipping, notice, newsletter } = INBOX;
  g.gmail.deliver({ ...person, text: "Are you free Saturday at seven?", date: ago(5) });
  g.gmail.deliver({ ...receipt, text: "Thanks for your order.", date: ago(30) }, UPDATES);
  g.gmail.deliver({ ...shipping, text: "Arriving by 8 p.m.", date: ago(45) }, UPDATES);
  g.gmail.deliver(
    {
      ...notice,
      text: "Sam opened a pull request.",
      date: ago(60),
      headers: {
        "List-Id": "acme/web <web.acme.github.com>",
        "Reply-To": "reply+ABCD@reply.github.com",
      },
    },
    UPDATES,
  );
  g.gmail.deliver(
    {
      ...newsletter,
      text: "Hello readers.",
      date: ago(90),
      headers: { "List-Unsubscribe": "<mailto:leave@stratechery.example>" },
    },
    PROMOTIONS,
  );
}
