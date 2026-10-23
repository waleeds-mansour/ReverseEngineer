# Integrating "agent-teammate" tech into Hearth / Nook / Pip

*Draft plan — 2026-10-22. Based on OpenAI **dots**' and xAI **Grok Bot**'s launch pages, mapped onto the real Hearth codebase.*

## TL;DR
Studying dots and Grok Bot is, mostly, **validation**: the industry converged on exactly the architecture Pip already has — an always-on agent, a proactive background loop, memory, an approval/auto-review gate, and browser control. You built the hard parts. The *new* ideas worth stealing are a short list, and two of them (an "Activity View" and **learn-by-demonstration routines**) map cleanly onto your "less manual / ship visible / reliability-first" priorities. One of them (an agent "computer") must be **re-shaped** to respect your no-container rule (D8).

## What dots and Grok Bot both do (the convergent pattern)
Both are: an **always-on agent** with its **own computer + browser**, that **signs into your tools and acts in them**, does **proactive background work**, turns **demonstrated workflows into reusable routines**, runs **auto-review/approval** on risky actions, lets you **watch/inspect its work**, and runs **multiple agents in parallel that hand work to each other**.

## Capability map: them vs. Pip today

| Pattern | dots / Grok Bot | Hearth/Pip today | Gap |
|---|---|---|---|
| Always-on agent | own process, 24/7 | ✅ `apps/jarvis` + `packages/jarvis` ReflexEngine/TurnRunner | none |
| Proactive background work | "proactive research" (read-only) | ✅ `heartbeat.ts` (cron `*/25 8-18`), reflexes, `proactiveGate` budget | none — ahead |
| Auto-review / approval of actions | "Auto Review", Custom Rules | ✅ `kernel/policy.ts` risk×caller, `approvals.ts`, `always-allow.ts`, taint/guard | **UI only** — rules aren't owner-editable in-app |
| Memory / learns you | context over time | ✅ `modules/memory` tiered recall + nightly consolidation | none |
| Acts in your tools | signs in, uses apps | ✅ browser via extension+CDP (`apps/server/src/browser`), Gmail/Cal/Slack/Notion/GitHub | narrower surface than "any app" |
| **Inspect its work** | Activity View, "open its computer" | ⚠️ data exists (events/audit/approvals, Nook bar) but **no timeline view** | **build a view** |
| **Learn by demonstration** | "show a Bot once → saved routine" | ❌ routines are instruction-authored only | **missing — high value** |
| Agent's **own computer** | cloud container + browser | ⚠️ browser yes; code work = **native git worktree** (planned `PLAN.md:529`, M7, **not built**) | **build native, NOT a container (D8)** |
| **Teams of agents in parallel** | many dots/bots, hand off work | ⚠️ single agent + Slack "member" (`member-turn.ts`), 2-worker queue | **missing — reliability risk** |
| Multi-channel presence | ChatGPT/Slack/Teams/SMS | ✅ web + Slack (owner + member) | add channels later |
| Named identity + onboarding | the "Dot" mascot cast | ✅ Pip persona (`prompts/jarvis.md`) | polish only |

> **Provenance:** every row is a *launch-page* claim from the two products (`openai.com/index/introducing-dots/`, `x.ai/bot`). Track 2 (demonstration routines) is **Grok-only**; the rest are from both.

## Prioritized tracks (ordered: value × low-risk × fits your rules)

### Track 1 — "What Pip did" Activity View  ·  *ship first, lowest risk*
**Why:** Your #1 ask is *visible progress* and trusting a proactive agent. dots' "Activity View" / Grok's "watch them act" is just a read-model over data you **already** log.
**Build:** a timeline in `apps/web` over the existing event log + `kernel` audit + approval inbox: each proactive turn, what it touched, what it set aside (`heartbeatItem`), what's awaiting approval — with a "why" line per action. Optionally surface a compact version in the Nook bar (`apps/desktop/.../nook/bar.rs`).
**Anchors:** `packages/kernel/src/{events,audit,approvals}.ts`, `apps/server` SSE stream, `apps/web`.
**Risk:** low (read-only). **Payoff:** high trust, demoable in a day or two.

### Track 2 — Learn-by-demonstration routines  ·  *biggest "less manual" win*
**Why:** The single most compelling new idea in both products. You already have the two halves — browser action capture and a routine/scheduler system — just not the bridge.
**Build:** "Pip, watch this" → record a browser/action session (CDP driver already captures clicks/nav/`world`/snapshots) → Pip synthesizes a candidate routine (a sequence of registry actions + params) → owner reviews/edits it → saved via `routine_*` tools and scheduled.
**Anchors:** `apps/server/src/browser/driver/{world,snapshot,input}.ts`, `packages/modules/src/routines/`, `packages/kernel/src/scheduler.ts`.
**Risk:** medium (synthesis quality) — but every run still flows through the kernel gate, so a wrong guess is caught, not executed. Start with browser-only routines.

### Track 3 — Custom Rules surface  ·  *small, visible, reliability-positive*
**Why:** dots' "Custom Rules" and Grok's "Auto Review" are a thin UX layer over what `always-allow.ts` + `policy.ts` already do. Making standing rules **owner-editable in-app** (allow / require-approval / block, per action, optionally scoped) turns an invisible mechanism into a control surface.
**Anchors:** `packages/kernel/src/{always-allow,policy}.ts`, settings in `kernel/settings.ts`, UI in `apps/web`.
**Risk:** low. Pairs naturally with Track 1.

### Track 4 — Pip's own "hands" for code work  ·  *native, kernel-gated — NOT a container*
**Why:** dots/Grok give the agent its own computer. **Your D8 rule forbids containers**, and `PLAN.md:529` already specs the Hearth-native version: *Pip works in a git worktree via a handoff prompt* (roadmap M7, unbuilt). This is the faithful adaptation — same capability, your rules.
**Build:** a kernel-registered, high-risk `code.*` action family that runs in an ephemeral **git worktree** (native, no Docker), with every outward step (push/PR/merge) gated by the existing approval path; the owner watches it in the Track-1 Activity View.
**Anchors:** `PLAN.md:529`, `packages/kernel` (new risk class + actions), existing `.claude/worktrees` pattern for reference.
**Risk:** higher — this is the one real architectural add. **Decision needed on scope** (see below). Keeps your "nothing containerized" rule intact.

### Track 5 — Parallel teammates (multi-agent)  ·  *defer; reliability cost*
**Why:** dots "teams of dots" / Grok "connect the bots." You have the seed: the **"member"** abstraction (`member-turn.ts`, trust-tiered, `policy.ts` member caller). Extending it to let Pip spawn scoped sub-agents that coordinate through the shared event log is the natural path.
**Risk:** highest for reliability (concurrency, races on the turn queue which today runs 2 workers + single member turn, D62). **Recommendation:** hold until Tracks 1–2 are solid; reliability-first.

### Track 6 — Channels + onboarding polish  ·  *opportunistic*
SMS/Teams channels; a light Pip onboarding/identity moment (the dots "mascot" idea) in the web/desktop first-run. Low urgency.

## Key decisions for you
1. **Track 4 scope** — do you want Pip to actually *do code work* in a native worktree now (realize M7), or keep it browser/app-actions only for the moment? This is the big fork.
2. **Track 5 appetite** — is parallel multi-agent worth the reliability risk soon, or explicitly shelved?
3. **Where this plan lives** — leave as a note, drop into `docs/research/`, or break the chosen tracks into lane tasks.

## Suggested sequence (reliability-first, visible weekly)
**Track 1 (Activity View) → Track 3 (Custom Rules) → Track 2 (demonstration routines) → Track 4 (native code hands, if approved) → Track 5 (parallel, later).**
Each lands as its own visible, independently-shippable change on the existing kernel/reflex spine — no big-bang rewrite.
