# Spec 6 — Event-triggered autonomous workflows · DESIGN ONLY (do not build yet)

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
