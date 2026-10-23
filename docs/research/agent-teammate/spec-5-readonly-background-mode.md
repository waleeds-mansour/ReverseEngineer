# Spec 5 — Enforced read-only "background mode" · DESIGN ONLY (do not build yet)

> **Source / provenance:** from ChatGPT **dots** — its page says *"proactive research runs read-only"*: background work can't send messages, edit app content or drive your computer unless you're there. *Marketing claim*, not reverse-engineered. (Grok's weaker equivalent is "Auto Review.") The mechanical hard-cap + badge below is Hearth-native, layered on the existing policy gate.

## Why this matters for Pip specifically
Pip's whole value is proactive background work — but the owner's #1 stated priority is **trust/reliability**, and "what might it do while I'm asleep?" is the fear. dots' answer is a *mechanical guarantee*: background work **physically cannot** reach outward actions, so the honest answer is "it can only read and take notes." Hearth is one small change away from being able to say the same.

## What Hearth does today (and the gap)
Proactive turns are gated on **whether they run at all**, not on **what they may do**:
```ts
// packages/jarvis/src/budget.ts
export async function proactiveGate(db, now): Promise<Gate> {
  if (await getSetting(db, "jarvis.paused")) return { open: false, reason: "paused" };
  const limit = await getSetting(db, "jarvis.proactiveTurnsPerDay");
  if ((await proactiveTurnsToday(db, now)) >= limit) return { open: false, reason: "budget" };
  return { open: true };
}
```
Once a proactive turn is running, its tool calls hit the normal agent policy — read/internal **allow**, self_external allow (ask if untrusted), outward/destructive **ask** (`packages/kernel/src/policy.ts:52-69`). So background work *can* queue outward actions that ping you for approval. **`mode` is never threaded into the per-call caller** (confirmed: `Caller` at `types.ts:8-37` has no `mode`; `runner.ts:105` mentions "proactive" only in a comment). There's no hard read-only guarantee, and nothing visible that says "right now Pip is read-only."

## Design: a mode flag that caps risk at the policy chokepoint + a badge
### The cap (one setting, one policy line)
1. **Setting** (`packages/kernel/src/settings.ts`): add `"jarvis.backgroundReadOnly": boolean` with a default in `SETTING_DEFAULTS`. Slots in exactly like `jarvis.paused`.
2. **Thread `mode` to the caller.** Add `mode?: TurnMode` to `Caller` (`types.ts:8-37`); set it in `buildTools`' `caller()` (`packages/jarvis/src/tools.ts:86-100`) from a new `state.mode`, populated in `runner.ts:191-203` from the turn row's `turn.mode` (the column already exists — `jarvis.ts:71`, `TurnMode = "reactive"|"proactive"`).
3. **The cap itself**, in `decide()`'s agent branch (`policy.ts:52-69`), *before* the read/internal allow at `:56`:
```ts
if (caller.mode === "proactive" && backgroundReadOnly && risk !== "read" && risk !== "internal")
  return deny("Background work is read-only; this was deferred to your brief.");
```
`deny` (not `ask`) is the point — a sleeping owner is **never pinged** by background work; the deferred item surfaces in the morning brief / Activity View instead. (`read` + `internal` stay allowed so Pip can still take notes, draft, and set tasks aside — matching dots, which keeps "research" able to record findings.)

### Where to read the flag
`decide()` is sync; pass `backgroundReadOnly` in alongside the existing `standingRule` arg (resolved once in `kernel.execute` before the `decide` call at `kernel.ts:92/114`), or resolve it in `guardAgentCall` (`packages/kernel/src/guard.ts:43-114`) which already runs only for agent/member callers — the natural home for a "turn-wide capability rule."

### The badge (this is what makes it *trusted*, not just safe)
- **Web:** a persistent "Background: read-only" chip in the Activity View (Spec 1) and the header whenever the flag is on; deferred-by-cap actions render as a distinct row ("would have emailed Acme — held for your brief").
- **Nook bar** (`apps/desktop/src-tauri/src/nook/bar.rs`): mirror the chip so the guarantee is visible on the desktop at a glance.

## Relationship to the other specs
- **Spec 3 (jobs) generalizes this.** A job's `riskCeiling` is the same mechanism with an arbitrary ceiling instead of a global boolean. **Build this first**, then Spec 3 reuses the exact `caller.mode`/ceiling plumbing. This spec is the minimal, shippable version (one global flag); jobs make it per-role.
- **Spec 1 (Activity View)** is where deferred items become visible — without it, a hard `deny` is invisible and feels broken. Ship Spec 1 first or alongside.

## Decisions to settle before building
1. **Default on or off?** dots ships proactive = read-only by default. Recommend **default ON** for background turns (it's the safe, trust-building default) with an explicit owner opt-in to let background work *ask* for outward again. This is a behavior change — your call.
2. **`internal` in or out?** Strict dots reading is "read-only." Hearth's `internal` = own-DB writes (notes, tasks, drafts) with no outward effect. Recommend **allow `internal`** (so background Pip still drafts and files) and cap only `self_external`/`outward`/`destructive`/`secret`. The alternative (deny everything above `read`) is stricter but mutes note-taking.
3. **Deny vs. defer-and-ask-later.** Hard `deny` (recommended — never interrupts) vs. queue the outward action as a *pending approval* the owner sees in the brief (softer, but that's a lot of held cards). Recommend deny + a single brief line listing what was held.

## Risk / effort
Low. One setting, one `Caller` field, one `decide()` line, one badge. The hardest part is threading `mode` into the caller (a few files, no logic risk). It is a *removal* of capability, so it cannot make Pip do more. Highest trust-per-line-of-code of the four.
