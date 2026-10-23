# Spec 4 — Mid-task "connect this tool" request · DESIGN ONLY (do not build yet)

> **Source / provenance:** from Grok **Bot** — *"Sign in to Salesforce so I can see your pipeline"*: the agent, mid-task, asks you to connect a tool it needs, then continues once you do. *Marketing claim*, not reverse-engineered. (dots has the weaker version — "connect your apps" at setup.) The inbox-card + resume realization below is Hearth-native, built on the existing approval/notification spine and connector flows.

## The gap today
When Pip needs an integration that isn't connected, the action just **errors**. Concretely, Notion's internal guard throws and the turn ends:
```ts
// packages/modules/src/notion/connect.ts:30-34
async function account(ctx: ActionContext) {
  const [a] = await ctx.tx.select().from(notionAccount).limit(1);
  if (!a) throw new ActionError("not_found", "Notion isn't connected.");
  return a;
}
```
Pip can *say* "connect Notion" in a reply, but there's no **card with a Connect button**, and no **resume** — the owner has to re-ask after connecting. Grok's move is: drop a connect card, pause the task, pick it back up automatically.

## Design: a typed "needs connection" signal → inbox card → resume
Three small pieces, each on existing rails.

### 1. A typed error every connector throws (replaces generic `not_found`)
Add to `packages/core/src/` a `ConnectionError` (subclass of `ActionError`, code `"needs_connection"`) carrying `{ provider: "notion"|"google"|"slack"|"github"; why: string; connectAction: string }`. Swap the connectors' "isn't connected" throws for it — Notion's `account()` above, plus Google's OAuth-absent path (`packages/modules/src/google/client.ts`), Slack, GitHub. `connectAction` is the existing connect action name (e.g. `"notion.connect"`), `why` is the task-level reason Pip fills in ("so I can create that task on your board").

### 2. The turn turns that error into a card + a resume check
In `applyOutcomes` / the turn runner, when a called action returns `needs_connection` (it surfaces through `kernel.execute`'s result, like `pending_approval` does at `packages/jarvis/src/outcomes.ts:174-184`), emit **two** outcomes instead of failing:
- a **`tell`** (→ `inbox.notify`, `outcomes.ts:143-162`) — the connect card: *"Pip needs Notion to finish 'X'. Connect it?"* with a deep-link to the Settings connect flow for `provider`.
- a **`check_later`** (→ `upsertSchedule`, `outcomes.ts:196-207`) keyed `connect-wait:<provider>:<turnId>`, so the task is **re-queued** when the connection appears (or after a backoff, to re-notify / give up).

This mirrors exactly how owner-created routines defer-and-resume via `check_later` + `onCheck` (`packages/modules/src/routines/index.ts:104-136`) — proven pattern, no new scheduler work.

### 3. Resume trigger
Each connector already emits a connected event on success (e.g. `notion.connect` calls `closeAlerts(ctx, "notion")` at `connect.ts:69`). Add a small **`connect.wait` reflex** (`mode: "always"`, deterministic, no model turn) that on the provider's connected event clears the matching `connect-wait:*` schedule and re-queues the original turn (by stored `turnId`). Result: owner clicks Connect → signs in → Pip picks the task back up on its own. Grok's exact behavior, on Hearth's spine.

## New / changed surface
- **add** `ConnectionError` in `packages/core/src/` + a `connect.request` action (`risk: "internal"`, `callers: ["owner","agent"]`) that builds the card for the explicit "ask me to connect X" path (Pip deciding up front it'll need something).
- **change** connectors (`notion/connect.ts:30-34`, `google/`, `slack/`, `github/`) to throw `ConnectionError` with a `why`.
- **change** `applyOutcomes` / runner to map a `needs_connection` result → `tell` + `check_later` (one branch beside the existing `pending_approval` handling).
- **add** `connect.wait` reflex (`mode: "always"`) to resume on the connected event.
- **web** — render the connect card in the Inbox (`apps/web/src/views/inbox/InboxItem.tsx`) with a **Connect** button that routes to the existing Settings connect UI for that provider; show it in the Activity View (Spec 1) too. Reuse `apps/web/src/lib/approvals.ts` card plumbing.

## Safety / privacy (unchanged rails)
- Connecting is still **owner-only, from Settings** — the card is just a prompt + deep-link; Pip never handles the secret. Notion's `notion.connect` is `risk: "secret", callers: ["owner"]` (`connect.ts:49-73`) and stays that way. The card **cannot** auto-connect.
- The `why` string is Pip's own words about the task, never pasted from outside content (don't let untrusted task bodies author it — gate with the existing `refuseUntrusted`/taint check).
- Deep-link targets are fixed internal Settings routes, never a URL from observed content.

## Decisions to settle before building
1. **Resume window.** How long does a `connect-wait` schedule live before Pip gives up and just reports it in the brief? (Recommend 24h, one re-notify at ~4h.)
2. **Proactive vs. reactive only.** Should a *proactive* (background) turn be allowed to post a connect card, or only a turn you started? (Recommend: proactive may post the card but it counts as an interrupt against `owner.maxInterruptsPerDay` — don't let background work nag.)
3. **Which connectors first.** Notion is the cleanest (single throw site). Google/Slack/GitHub next. Recommend Notion as the v1 worked example.

## Risk / effort
Low–medium. One typed error, one `applyOutcomes` branch, one deterministic reflex, one card renderer. Everything rides the existing notify/approval/schedule spine. Pairs naturally with Spec 1 (the card shows in the timeline) and Spec 3 (a job can declare which connectors it expects).
