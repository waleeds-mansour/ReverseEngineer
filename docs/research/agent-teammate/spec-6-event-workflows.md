# Spec 6 — Event-triggered autonomous workflows · BUILT (2026-10-23)

> **As built.** The owner asked for it on 2026-10-23, with the four decisions below settled as
> recommended: turn-only targets (plus an optional job, since Spec 3 had landed), exact-equality
> filters, a curated list of event kinds, and proactive turns. Table `owner_trigger` (migration
> 0051; TRIGGER is SQL's own word), actions `trigger.create/update/list/remove` and the reflex
> `trigger.fire` (`packages/modules/src/triggers/`), "Triggers" in Settings, and "Your trigger:
> <name>" on its cards in What Pip did. Where the build differs from the design below:
> - **The event kinds are a fixed list** (`triggers/kinds.ts`): an email arrives, a task is
>   assigned or moves, a calendar event changes, a Notion ticket becomes yours or is done, a pull
>   request opens or merges. So `trigger.fire` listens to that list statically; nothing re-registers
>   its `on` at runtime. Each kind names the fields a filter may test (an email's `from`, a pull
>   request's `repo`, `author`, `mine`), and Settings offers them. Notion's first read of the board
>   (`backfill`) fires nothing.
> - **A filter is equality only**, every field, case and spaces aside. No patterns, no "or".
> - **The target is always one turn**, `jarvis_turn.trigger = 'trigger'`, with your words as the
>   prompt and the event's fields shown as data. A trigger can name one of Pip's jobs (`role_id`):
>   its turns are tagged and run within the job's ceiling and turns a day, and a job that's off
>   pauses it, as for a routine. Routine targets weren't needed: a routine can be in a job already.
> - **The reflex is reactive and its turns proactive** (as `connect.wait` does it), so no job can
>   take on every trigger at once: each trigger names its own. Its turns count against Pip's daily
>   turns, are capped by Spec 5's read-only setting, and stop while Pip is paused (checked in the
>   reflex, so a pause leaves no skipped rows).
> - **Loop guard**: nothing Pip's own work led to, whether Pip did it (`actor = 'jarvis'`) or it
>   came of a call in one of Pip's turns (its correlation id is the turn's). **Rate**: once per event
>   (`dedupeKey` per trigger and event) and `per_day` turns a trigger (10 unless set, 50 at most).
> - **Outside content stays outside**: mail, calendar, Notion and GitHub kinds start their turn
>   untrusted (D25), whoever ran the sync.
> - **A plain table, not an entity**, like a job. Pip can make, tighten, pause and remove a trigger
>   from a trusted turn; only you can loosen one (back on, more turns, a looser filter, out of its
>   job). Outside content can do none of it (`refuseUntrusted`).
> - Chains (below) work through the event log as designed, but each link is its own card; grouping
>   a chain into one card is not built.

> **Source / provenance:** from **both** pages — Grok **Bot** ("Bots act on triggers / work in the background") and ChatGPT **dots** ("set a dot loose on a goal; it works proactively"). *Marketing claims*, not reverse-engineered. The owner-declared trigger model below is Hearth-native and is the *dynamic sibling* of the compiled reflex system that already ships.

## What Hearth already has (most of this)
The event→autonomous-work spine is **built**. Compiled reflexes match event kinds and emit work:
```ts
// packages/kernel/src/types.ts:235-251 — ReflexDef
export interface ReflexDef {
  name: string; description: string;
  mode: ReflexMode;        // "reactive" | "proactive" | "always"
  on: string[];            // event kinds; "*" = all
  run(event, ctx): ReflexOutcome[] | Promise<ReflexOutcome[]>;
  onCheck?(payload, ctx): Promise<ReflexOutcome[]>;   // when a check_later comes due
}
```
The engine dispatches them (`packages/jarvis/src/engine.ts:67-75`), and `applyOutcomes` turns an outcome into either a **queued `jarvis_turn`** (`outcomes.ts:113-124`) or a **direct `kernel.execute` call** (`act`, `outcomes.ts:174-184`). Chains already work: a reflex's `act` emits events (carrying `correlationId`/`causationId`, `graph.ts:114`) that other reflexes react to. Real example — `notion.to_tasks` (`packages/modules/src/notion/to-tasks.ts:33-73`) turns four Notion event kinds into task actions today.

**So the engine is not the gap.** The gaps are two:
1. **Owner-declared triggers.** Reflexes are *compiled code*. The owner can create *cron* routines at runtime (`routine` table + `routine.create`, `packages/modules/src/routines/index.ts:148-167`) but **cannot** create *event-triggered* ones. There's no "when X happens, do Y" the owner can author in their own words.
2. **Composable chains as a first-class thing** the owner can see/name (ties to Spec 1).

## Design: dynamic event-triggers = the `routine.due` pattern, keyed on events instead of cron
This is a near-copy of how dynamic routines already work. Dynamic routines are rows fired by a per-row `check` schedule → `routine.due` reflex `onCheck` → a turn whose prompt is the owner's stored instructions (`routines/index.ts:104-136`). Do the same, but fire on an **event kind** instead of a clock.

### Data model (mirror `routine`, `vault.ts:22-28`)
```
trigger  (entityId pk,
          on text,                 -- event kind to match, e.g. "mail.received", "notion.task_assigned"
          filter jsonb|null,       -- optional match on payload (from sender, label, board…)
          instructions text,       -- what to do, in the owner's words (never from outside content)
          target ∈ turn|routine|job,  -- run a one-off turn, an existing routine, or a job (Spec 3)
          targetId uuid|null,      -- the routine/job to run when target≠turn
          active bool default true)
```

### One generic compiled reflex does the lookup
Add a single `owner.trigger` reflex, `mode: "proactive"`, that matches the union of event kinds the owner has triggers for (register its `on` from the distinct `trigger.on` values at startup + on `trigger.create`). Its `run(event)`:
1. loads active `trigger` rows whose `on` matches `event.kind` and whose `filter` matches `event.payload`,
2. for each, emits the right outcome — a `turn` (prompt = stored `instructions`, like `routine.due`), or re-queues the named routine/job.
It **must** set `includeJarvisEvents: false` (default) so it can't loop on Pip's own events, use a `dedupeKey` per (trigger, event) so a burst can't double-fire, and being `proactive` it counts against the daily budget and stops when `jarvis.paused` — all three are the existing loop/cost guards (`engine.ts:69-73`).

### Owner actions (module `packages/modules/src/triggers/`, copy of `routines/`)
`trigger.create` / `update` / `list` / `remove`, all `risk: "internal"` except `list` (`read`), `callers: ["owner","agent"]`, guarded by `refuseUntrusted` (`routines/index.ts:29-35`) — **a trigger's instructions and filter can never come from outside content** (same rule as routines; this is the key safety invariant, because a trigger auto-runs).

## Chains (reflex → routine → job → code-run)
With triggers + jobs (Spec 3) + code hands (Spec 2), a workflow is a *declarative chain*, each step firing the next through the event log:
- `mail.received(from: acme)` → **trigger** → a *turn* that drafts a reply + emits `task.created`
- `task.created(label: code)` → **trigger** (target: job "Dev") → a *code-run* (Spec 2) in a worktree
- `code_run.finished` → **trigger** → *turn* that posts the PR link to the task thread
Nothing new in the engine — each arrow is an event a reflex reacts to, exactly as `notion.to_tasks` reacts today. Spec 1 (Activity View) renders the chain via `correlationId` as one grouped card, which is how the owner *sees* a workflow run end-to-end.

## New / changed surface
- **add** `trigger` table + migration (`packages/db/src/schema/vault.ts` neighborhood).
- **add** `packages/modules/src/triggers/` — the `trigger.*` actions + the generic `owner.trigger` reflex (copy `routines/index.ts` + `when.ts` shape, swap cron for event-match).
- **change** reflex registration so the `owner.trigger` reflex's `on` set is refreshed from the table (`registerRoutines`-style, `packages/jarvis/src/service.ts:40-56`).
- **web** — a "Triggers" surface in Settings (list/toggle, like routines) + chain rendering in Activity (Spec 1).

## Safety (the auto-run invariants)
- **Instructions/filter never from outside content** (`refuseUntrusted`) — a malicious email can't author a trigger that then runs on the *next* email.
- **Proactive + budgeted + pausable** — background triggers stop when paused and count against `jarvis.proactiveTurnsPerDay`.
- **Read-only cap applies** — if Spec 5's background mode is on, a trigger's proactive turn is capped at read/internal, same as any proactive turn. So "set Pip loose on events" is bounded by the same guarantee.
- **No self-loop** — `includeJarvisEvents: false` + `dedupeKey` prevent runaway chains.

## Decisions to settle before building
1. **Targets in v1.** Start with `target: turn` only (owner's-words → one turn), the direct `routine.due` analog? Or include `routine`/`job` targets from the start? Recommend **turn-only v1**, add routine/job targets once Spec 3 lands.
2. **Filter language.** How rich is `filter` — exact payload-field equality (simple, recommended) vs. a small expression grammar (powerful, more surface/risk)?
3. **Which event kinds are offerable.** Expose all event kinds, or a curated allow-list (mail/task/calendar/notion) so the owner doesn't wire a trigger to an internal plumbing event? Recommend a **curated allow-list** surfaced in Settings.
4. **Depends on Specs 1 (visibility), 3 (job targets), 5 (read-only cap)** to be fully realized — but turn-only triggers are shippable on their own after Spec 1.

## Risk / effort
Medium. The engine already does the hard part; this is a table + a module (copy of `routines/`) + one generic lookup reflex + a Settings surface. Main risk is the auto-run safety invariants — mitigated entirely by reusing the routine `refuseUntrusted`/proactive/dedupe guards that already exist. Lands after Spec 1; composes with 2/3/5.
