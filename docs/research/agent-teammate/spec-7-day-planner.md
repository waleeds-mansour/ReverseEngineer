# Spec 7 — AI day-planner: time-block your tasks into free gaps · DESIGN ONLY (do not build yet)

> **Source / provenance:** from **Morgen's "plan your day"** — auto-schedule unscheduled tasks into
> free calendar gaps, respecting working hours, estimates and priorities; the user accepts or
> reshuffles. That's Morgen's public product idea (`docs/research/morgen.md` §2); Morgen is closed
> source, so nothing here comes from its code. The deterministic-fit + inbox-approval realization
> below is Hearth-native, on the existing free/busy + approval + routine spine, and runs on your PC.

## The gap today
Hearth already has every input — and, surprisingly, already *writes* focus blocks, just **silently,
one task at a time**. `calendar.block_task` (`packages/modules/src/calendar/blocks.ts:128-135`,
`risk: "self_external"`), the 6:10 a.m. `blockRoutine` (`calendar.time_blocks`, `blocks.ts:154-168`)
and the proactive `blockReflex` (`blocks.ts:170-202`) drop `Focus: <title>` events onto the calendar
through `insertEvent` (`packages/modules/src/calendar/actions.ts:75-102`) with **no review**. What's
missing is Morgen's actual move: **one whole-day plan across all open tasks that the owner sees and
accepts as a unit** before anything lands. There is no `plan.day`, no plan card, no "approve the
day" step — only per-task writes that already happened.

## Design: four small pieces, each on existing rails

### 1. A deterministic planner (pure, unit-testable, no model)
A pure `planDay(input): { blocks, unplaced }` — the per-task fit `blocks.ts` already does (PLAN.md
§6.2), lifted to the whole day. Inputs: free slots from `freeSlots(db, from, to, minutes, rules,
BUFFER_MINUTES)` (`packages/modules/src/calendar/free.ts:78-91`); open owner tasks with `priority`,
`estimateMinutes`, `dueAt`/`dueIsDate` (`packages/modules/src/tasks`, the `bigTasks` candidate set —
open, not Jarvis's, estimate ≥ the `calendar.blockMinMinutes` setting, `blocks.ts:137-152`); and
`owner.dayRules` (workStart/workEnd/eveningStart/workDays/timeZone, `free.ts:43-57`). It reuses
blocks.ts's constants — `MAX_BLOCK_MINUTES` 120, `MIN_BLOCK_MINUTES` 30, `BUFFER_MINUTES` 10,
quarter-hour quantize (`blocks.ts:20-27,96-116`) and the undated-horizon rule
(`UNDATED_HORIZON_DAYS` 7, `blocks.ts:65`). Order earliest-deadline-first (by `dueAt`, then
`priority`) into the earliest slots; anything that won't fit before its due time returns as
`unplaced` — today's `calendar.no_room` signal (`blocks.ts:117-124`). Because `freeSlots` already
subtracts busy time with a buffer, the plan can't double-book: no new conflict logic, `conflicts.ts`
stays the detector it is.

### 2. A `plan.day` kernel action (compute only — writes nothing)
`defineAction({ name: "plan.day", risk: "internal", callers: ["owner","agent"] })` returning
`{ blocks: ProposedBlock[], unplaced: [...] }`. Pure read + compute, so the matrix lets owner and
Pip call it freely (`packages/kernel/src/policy.ts:72`, read/internal → allow). This is the
on-demand path: "plan my day" in a conversation returns a proposal and never touches the calendar —
mirroring `calendar.free_time` (`packages/modules/src/calendar/index.ts:186-208`, `risk: "read"`
over the same `freeSlots`).

### 3. Pip never writes silently — the plan is a `pending_approval` card
Writing is a separate, approval-gated step. Add `calendar.commit_plan({ blocks })`
(`risk: "self_external"`, `callers: ["owner","agent"]`) whose `summarize` renders every block as one
injection-safe line via `describeTimes`/`plainTitle` (`actions.ts:160-169`) and whose handler writes
each block through the same `insertEvent` path `calendar.create_event` uses
(`actions.ts:75-102,177-191`). The planner **always proposes it with `ask`** — the `act` outcome's
`o.ask` → `askFirst` (`packages/jarvis/src/outcomes.ts:178-190`) — so even for a *trusted* agent the
matrix returns `ask` (`policy.ts:70`) and the kernel holds it as one `approval` row + inbox card
(`packages/kernel/src/approvals.ts:41-100,132-173`), titled "Pip asks: …". `askFirst` also disables
always-allow (`approvals.ts:76-77`), so each day is its own yes. On the owner's quoted OK,
`resolveApproval(…, "approve", …)` (`approvals.ts:186-379`) re-validates the exact blocks and runs
the write as the original requester. One card, whole day, one yes — Morgen's "plan your day",
approval-gated. (`self_external` alone would let a trusted agent write unasked, `policy.ts:73-77`;
the `ask` is the guarantee, not a convention.)

### 4. A morning routine + a re-plan reflex
- **Morning routine** — a `planDayRoutine` (`RoutineDef`) beside `briefRoutine` in
  `packages/modules/src/assistant/routines.ts`, registered in the assistant module like
  `[briefRoutine, journalRoutine]` (`assistant/index.ts:72`); cron ~7:00 a.m. so the plan lands
  after the 6 a.m. prep and before the 8:15 brief (`routines.ts:11-13`). Its `run` is deterministic
  like `blockRoutine`: compute `planDay` for today and, if non-empty, emit one
  `act: calendar.commit_plan` with `ask` (the held card). Nothing is written until you say yes.
- **Re-plan reflex** — `calendar.replan_day` (`ReflexDef`, `mode: "always"`) on the event-workflow
  spine (spec-6), `on: ["calendar.event_changed","calendar.no_room","task.due_changed",
  "task.status_changed"]` (`index.ts:79-94`, `tasks/index.ts:25-36`). Being `always` it is
  deterministic, spends no model turn and runs even while Jarvis is paused. On a **material** change
  to *today's* remaining plan (a new/moved busy event over a Focus block, a task finished or
  re-dated) it debounces with a `check_later` keyed `replan:<localDate>`
  (`outcomes.ts:202-213` — the exact trick `blockReflex` uses, `blocks.ts:190-197`); on `onCheck` it
  re-runs the fit and, if the day changed, emits a **`tell`** card — "Your day shifted; want an
  updated plan?" (`outcomes.ts:147-167` → `inbox.notify`) — **never a silent rewrite**. The owner
  taps it to get a fresh `plan.day` → held commit.

## New / changed surface
- **add** `planDay()` pure fit + a `ProposedBlock` type beside `blocks.ts`/`free.ts` in
  `packages/modules/src/calendar/`, with unit tests like the fit already has
  (`conflicts.test.ts`/`writes.test.ts` neighborhood).
- **add** `plan.day` (compute) and `calendar.commit_plan` (held write) to the calendar module's
  action list (`index.ts:126-224`); the writer + `summarize` live in `actions.ts`.
- **add** `planDayRoutine` to `assistant/routines.ts` (register in `assistant/index.ts:72`); **add**
  the `calendar.replan_day` reflex to the calendar module's `reflexes: […]` (`index.ts:225`).
- **change** the silent morning blocker: the 6:10 a.m. `blockRoutine` (`blocks.ts:154-168`) is
  superseded by the reviewed plan (decision 2); `calendar.block_task` stays as the per-block
  mechanism the commit uses, and `blockReflex` becomes a feeder for the re-plan `tell` rather than a
  silent writer.
- **web** — render the plan card in the Inbox (`apps/web/src/views/inbox/InboxItem.tsx`) with
  Approve / Reshuffle, reusing `apps/web/src/lib/approvals.ts` card plumbing; show it in the
  Activity View (spec-1) grouped by `correlationId`.

## Safety / privacy (unchanged rails)
- **Never silent.** Every calendar write goes through the held `calendar.commit_plan`; the
  `ask`/approval is the guarantee. A whole-day plan can't be "always-allowed" (`askFirst` drops the
  rule, `approvals.ts:76-77`).
- **Local.** `planDay` runs on your PC from your own DB; nothing leaves.
- **Injection-safe card.** Block lines are built from task titles via `plainTitle`
  (control-chars stripped, quoted, one line, `actions.ts:160-166`), so a title sourced from outside
  content (an email-born task) can't forge extra approvals; an untrusted-origin proposal stays
  untrusted through the approval (`approvals.ts:102-130`).
- **Own calendar only.** `insertEvent` writes guest-free events on your own calendar
  (`actions.ts:66-73`); the planner never invites anyone.
- **Pausable + budgeted.** The re-plan detector is `always` (pause-surviving, zero cost) but only
  *notifies*; any proactive re-proposal counts against the daily budget and stops when
  `jarvis.paused` (spec-6 guards).

## Decisions to settle before building
1. **An `always` reflex can't hold a write.** It acts as `systemCaller`, and `policy.ts:55-58` never
   forces system to ask — so `calendar.replan_day` must only *notify* (the `tell` above), never emit
   the commit. For auto-re-proposal without a tap, make it `mode: "proactive"` instead (agent caller
   → `askFirst` holds, and it's then budgeted/pausable, exactly like `blockReflex`). Recommend
   `always` + `tell` for v1; proactive auto-propose later.
2. **Supersede or coexist with the silent blocker?** Does the reviewed plan replace the 6:10 a.m.
   `blockRoutine`, or run alongside it? Recommend superseding the silent morning write; keep
   `calendar.block_task` as the per-block primitive and the ad-hoc "block this one task" action.
3. **Stale plan at approval.** The calendar can change between propose and OK. `resolveApproval`
   re-checks the input hash, not the calendar — an approved block could now overlap a just-added
   meeting. Recommend the commit handler re-check each block against `busyTimes`/`conflicts.ts` at
   write time and skip (and report) any that no longer fit, rather than double-book.
4. **Which tasks are in scope.** Owner-assigned + unassigned open tasks with an estimate ≥
   `calendar.blockMinMinutes`, ordered due-then-priority (the `bigTasks` set)? Or also fit small or
   undated tasks into leftover gaps? Recommend the big-task set for v1.
5. **Reshuffle.** Approve/deny only, or approve-with-edits (drag a block)? Recommend approve/deny for
   v1 (deny → adjust a task's estimate/due and re-run); edits later.

## Risk / effort
Low–medium. One pure function (the fit already exists per-task in `blocks.ts`), two actions (one
compute, one held write), one routine, one detector reflex, one card renderer — all on the
free/busy + approval + routine spine, no new infrastructure. The one genuine subtlety is the
caller/ask matrix (decision 1). Pairs with spec-1 (the plan shows in the timeline), spec-5
(read-only background mode caps any proactive re-propose) and spec-6 (the re-plan reflex is one
event-workflow). It's a design for now: the owner decides when to build it.
