# Research: Morgen (morgen.so)

Source: Morgen's public product, as of 2026-10-23. Morgen is a closed-source, commercial calendar
and planning app, so unlike [macro.md](macro.md) there's nothing to lift: this is **ideas only**,
written in terms of Hearth's own code.

**Verdict: take four ideas, build none of Morgen.** Hearth's `calendar` module already covers most
of what a calendar app needs (canonical events, occurrences, free/busy, invites, series, RSVP,
briefs), much of it from Macro. What Morgen adds:
1. **a provider-neutral calendar layer**: Morgen puts Google, Microsoft, iCloud and other CalDAV
   calendars in one place, and Hearth is Google-only;
2. **a whole-day plan you approve at once**: Morgen plans your day from your tasks. Hearth already
   blocks time for tasks, but silently and one task at a time;
3. **two-way sync with outside task apps**: Morgen keeps tasks in step with other tools;
4. **booking links**, later.

## 1. Calendars from more than Google

**Today.** `packages/modules/src/calendar` is wired to Google only, through
`packages/modules/src/google`. Sync (`calendar/sync.ts`) and the calendar list (`calendar/calendars.ts`)
speak Google's API directly.

**What we take:** a `CalendarProvider` interface, the calendar twin of the planned `MailProvider`
([macro.md](macro.md) §2). One interface: list calendars, incremental sync with an opaque cursor,
read events, write an event, RSVP, free/busy. Google becomes the first adapter. **CalDAV** comes
next, which covers iCloud, Fastmail and self-hosted servers for little code, then **Microsoft
Graph**. This is the highest-reach idea here.

**What we keep:** everything Hearth already has. The canonical event with its provider sources,
per-occurrence overrides and materialized occurrences; reminders as a rebuildable schedule with
exactly-once delivery; invite snapshots matched to the live event for RSVP; and echo suppression,
so sync ignores Hearth's own writes. These live in `calendar/sync.ts`, `series.ts`, `invites.ts`,
`respond.ts` and `actions.ts`. Providers are always called from the PC.

## 2. A whole-day plan you approve

**Today.** Hearth already writes focus blocks, but without asking, one task at a time
(`calendar/blocks.ts`: `block_task`, the 6:10 a.m. `blockRoutine` and the proactive `blockReflex`,
all through `insertEvent` in `calendar/actions.ts`).

**What we take:** one plan for the whole day, across every open task, that you see and accept as a
unit before anything lands. Every input exists already:
- free/busy: `calendar/free.ts`;
- time blocks and conflicts: `calendar/blocks.ts`, `calendar/conflicts.ts`;
- tasks with due dates, priorities and estimates: `packages/modules/src/tasks`;
- the agent spine: kernel actions (risk × caller), the `tell`, `check_later` and `act` outcomes
  (`packages/jarvis/src/outcomes.ts`), and routines (`assistant/routines.ts`).

The design is [spec-7-day-planner.md](agent-teammate/spec-7-day-planner.md): a deterministic fit
(no model), a `plan.day` action that only computes, and a held `calendar.commit_plan` that writes
nothing until you say yes. A morning routine proposes the day, and a re-plan reflex tells you when
the day has shifted.

## 3. Two-way sync with outside task apps

**What we take:** one contract for any outside task list that Hearth mirrors both ways. A
**selector** names the item, a **patch** carries only the changed fields, and every write Hearth
makes is **tagged** so the next sync ignores its own echo. Each write goes through the kernel like
any other action. It follows the local-first and echo-suppression rules Hearth already took from
Macro.

The first adapter should be **Microsoft To Do** (through Graph, which the calendar work needs anyway)
or a **markdown vault**. Apple Reminders is out: Hearth is Windows-first.

## 4. Booking links

**What we take:** a page that offers your free times, built on `calendar/free.ts`, where a pick
becomes a held event you confirm. Lowest priority.

## What Hearth keeps local

Whatever another app does, Hearth's posture stays the same:

| | Hearth |
|---|---|
| Calendar providers | Called from your PC; tokens never leave it |
| Planning | Runs on your PC from your own database |
| The agent | Pip, on your own Agent SDK login |
| Analytics | None from third parties; nothing records your screen |
| Errors | Stay local |
| Code | Self-hosted and open (MIT), on one PC |

## Where each idea comes from: Macro, Morgen and Hearth

| Capability | Macro gave | Morgen adds | Hearth today |
|---|---|---|---|
| Calendar data model | canonical event, occurrences, exactly-once reminders | — | **have** (`calendar/*`) |
| Calendar providers | Google mirror | Microsoft, iCloud and CalDAV in one place | Google only → **add the interface** |
| Incremental sync | cursor, local-first, echo suppression | several sources per event | Google cursor sync |
| Tasks | task = doc, one scheduler | two-way sync with outside task apps | `tasks` module |
| Day planning | — | **a whole-day plan you approve** | silent per-task blocks → **`plan.day`** (spec 7) |
| Connectors | MCP catalog | — | the Connect card (spec 4) |
| Booking | cal.com (left) | booking links | — → a later module |

## Plan (design only, in order of value, all on existing rails)

1. **`CalendarProvider` interface**: Google stays as adapter one; CalDAV and Graph follow.
2. **`plan.day` and the planner routine** (spec 7): a held day plan, re-planned through a reflex.
3. **The task-mirror contract**: selector, patch and echo tag; Microsoft To Do or a vault first.
4. **Booking**: free times from `calendar/free.ts`, a pick held until you confirm.

Each one rides the kernel, the outcomes, reflexes, routines, the Connect card (spec 4) and event
triggers (spec 6). None needs new infrastructure.
