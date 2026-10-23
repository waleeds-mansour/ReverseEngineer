# Spec 1 — Activity View ("What Pip did, and why") · BUILD

> **Source / provenance:** pattern from **both** announcement pages — ChatGPT **dots** ("open your dot's computer at any time to inspect its work"; the named *Activity View*) and Grok **Bot** ("you watch them take action instead of approving every step"). Both are *marketing claims*, not reverse-engineered. The audit/approval/heartbeat timeline mechanics below are **Hearth-native** (existing `Activity.tsx` + kernel tables), not copied from their binaries.

## Current state (don't greenfield)
`apps/web/src/views/Activity.tsx` already exists (route `"activity"`, title *"What Pip did"*). It reads three actions:
```ts
useAction<Turn[]>("jarvis.activity", () => ({ limit: 100 }));
useAction<Watch[]>("jarvis.watches");
useAction<Observation[]>("observation.list", () => ({ limit: 50 }));
```
So it shows **turns, watches, observations** — but NOT: the **audit trail** (every gated action, its risk, decision, outcome), **approval history** (only pending is shown, via Inbox), or the **heartbeat items** Pip set aside. This spec fills those three gaps and stitches everything into one correlation-grouped timeline.

## Goal
One scannable timeline answering "what did Pip do while I was away, why, what did it touch, and how did it go" — grouped so a single trigger (a heartbeat, a reflex, your ask) and all the actions/approvals/events it produced read as **one card**, via the shared `correlationId`.

## Data sources (all already persisted)
| Need | Table / type | Anchor |
|---|---|---|
| Actions Pip ran + decision/outcome | `audit` (principal, origin, via, action, risk, input, outcome∈ok\|error\|pending_approval\|denied, error, durationMs, **correlationId**, approvalId) | `packages/db/src/schema/inbox.ts:84` |
| Approvals + results | `approval` (status, summary, reason, result, decidedBy, correlationId…) | `inbox.ts:18` |
| Turns (the "why" + reply) | `jarvis_turn` (trigger, mode, lane, outcome, reply, toolsUsed, writes, timings, error) | `packages/db/src/schema/jarvis.ts:68` |
| Set-aside items | `heartbeat_item` (text, aboutId, sourceEventSeq, takenAt) | `jarvis.ts:117` |
| What it touched | `event` (kind, entityId, payload, **correlationId**, causationId) + `entity.title` | `graph.ts:114`, `graph.ts:32` |

**Join key:** `correlationId` is on `audit`, `approval`, and `event`; `jarvis_turn` has `id` used as the turns' correlation. Group by it.

## New kernel read-actions to add
There is **no audit/heartbeat read-action today** (`audit.ts` has no `.select` wrapper). Add a small module `packages/modules/src/activity/` (or extend `packages/modules/src/approvals/`):

1. `activity.audit` — `risk: "read"`, input `{ limit?: number (≤200); since?: ISO; outcome?: "ok"|"error"|"pending_approval"|"denied"; principal?: string }`, returns audit rows newest-first. Owner-only via `callers: ["owner"]`.
2. `activity.heartbeat` — `risk: "read"`, input `{ taken?: boolean; limit? }`, returns `heartbeat_item` rows (what Pip noticed but didn't act on).
3. *(optional)* `activity.timeline` — `risk: "read"`, server-side aggregator that pulls recent `jarvis_turn` + `audit` + `approval` + `heartbeat_item`, groups by `correlationId`/`turnId`, resolves `entityId`→title, and returns unified `TimelineGroup[]`. This keeps the client dumb. Recommended.

Register the module in `apps/jarvis/src/main.ts` + `apps/worker/src/main.ts` module lists; `Registry.checkJarvisContract` enforces `module.verb` naming.

## Web changes
- `apps/web/src/lib/types.ts` — add `AuditRow`, `HeartbeatItem`, `TimelineGroup` (mirror `Turn` at `types.ts:131`).
- `apps/web/src/views/Activity.tsx` — add the new `useAction` calls; render a correlation-grouped timeline. Each group: **trigger** (turn.trigger/mode: "heartbeat", "your ask", "reflex: deadline sweep"), **actions** (action name, risk pill, outcome pill, durationMs), **touched** (entity titles, linkable to panes), **approvals** (status + result), and the **reply/outcome** (act/ask/tell/note/nothing). Mirror the row styling in `apps/web/src/views/inbox/InboxItem.tsx`.
- Live refresh: `apps/web/src/lib/live.ts` already invalidates solid-query caches per event via `affectedBy(e)` (`lib/invalidate.ts`). Add invalidation rules so `approval.resolved`, `approval.requested`, `notification.created`, `jarvis.observed`, and action/entity events refresh the new queries. (Audit writes don't emit events, so either refetch on the correlated `*.resolved`/entity events, or give `activity.audit` a short `pollMs` while the view is open.)
- Optional: a compact "last thing Pip did" line in the Nook desktop bar (`apps/desktop/src-tauri/src/nook/bar.rs`) — later, not in v1.

## UX shape
```
Today
  ▸ 09:25  Heartbeat                                   [proactive · deep]
      • read mail (×12)                                 read · ok
      • task.create "Reply to Acme re: pricing"         internal · ok   → T-214
      • email.send draft to acme@…                      outward · ASKED  ⏳ awaiting you
      “Set aside 2 items; drafted 1 reply for approval.”
  ▸ 08:40  You asked: "summarize the Linear thread"     [reactive · fast]
      • notion.search / browser_read_page (×3)          read · ok
      “Summarized; posted to #product.”
```
Pending-approval rows deep-link to the existing Inbox approval card (`decide`/`alwaysAllow` in `apps/web/src/lib/approvals.ts`).

## Risk / effort
Read-only over existing data. No kernel-policy changes, no new writes. Effort: ~1 read-action module + 1 aggregator + extend one view. Independently shippable; demoable this week.

## Open choices
- `activity.timeline` server aggregator (recommended) vs. 3 raw lists joined client-side.
- Retention already favors us: `audit` keeps 90d (14d for heartbeat-origin) — the view is naturally bounded.
