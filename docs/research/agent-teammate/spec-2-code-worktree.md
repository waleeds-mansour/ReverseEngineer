# Spec 2 — Pip's code hands: native git worktree · DESIGN ONLY (do not build yet)

> **Source / provenance:** the "agent has its own computer" idea is from **both** pages — ChatGPT **dots** ("their own cloud computer") and Grok **Bot** ("each Bot has its own computer") — *marketing claims*. The **native git-worktree realization is Hearth's own** (`PLAN.md:529`, D8 no-containers) and is the *opposite* of their cloud-container approach. This spec stays code work in a worktree only: no screen capture or desktop control.

## Principle
dots/Grok give each agent a **cloud container**. **D8 forbids containers** ("Jarvis is never containerized", `docs/decisions.md:87`; `PLAN.md:112`). The Hearth-native equivalent is already written down: *"Jarvis works in a git worktree using Macro's handoff prompt (task, branch, comment history, conventions), streams progress into the task's thread, and records the run on the task. You merge, and only you push."* (`PLAN.md:529-531`, roadmap M7). This spec designs that — native, no containers, kernel-gated. **Greenfield:** no first-party worktree/`spawn` code exists for this today (verified).

## Capability boundary (the safety spine)
This is the first time Pip gets to **execute code/commands**, so every step rides the existing kernel gate (`packages/kernel/src/kernel.ts` `execute`: policy→approval→handler→audit→events). Rules:
- **Workdir is the worktree only.** Each run gets an ephemeral `git worktree add` under a dedicated root (e.g. `D:\hearth-build\code-runs\T-###`), never touching live `D:\Hearth` (mirrors the CI isolation rule in `docs/decisions.md` ~line 2006).
- **"You merge, and only you push."** Pip may create/commit in the worktree; **push/PR/merge are NOT agent powers.** Model them as `risk: "outward"` actions with `callers: ["owner"]` (owner-only), or route through the approval inbox so nothing leaves the machine without your yes.
- **Taint.** If the task body is `outside: true` (came from untrusted content), `packages/jarvis/src/taint.ts` + policy already escalate outward steps to **ask** — keep that.
- **Repo allow-list.** A setting enumerates which repos Pip may open a worktree in; **exclude Hearth's own live tree** by default.

## New kernel actions (module `packages/modules/src/code/`)
Shape follows `ActionDef` (`packages/kernel/src/types.ts:77`), registered like any module (`defineModule`).

| Action | risk | callers | io | Purpose |
|---|---|---|---|---|
| `code.start` | `internal` | owner (+ agent *ask-first*) | `io:true` | Create worktree for a task, build the handoff prompt, kick off the run. Long-running → `io:true` so it doesn't hold a DB tx (`kernel.ts:180`). |
| `code.status` | `read` | owner, agent | — | Report a run's state/progress. |
| `code.cancel` | `internal` | owner | — | Stop a run, leave the worktree for inspection. |
| `code.push` / `code.open_pr` | `outward` | **owner only** | — | Push branch / open PR. Per PLAN: you push, not Pip. Gated regardless. |
| `code.cleanup` | `internal` | owner, agent | — | `git worktree remove` after merge. |

`code.start` input (zod): `{ taskId: id; branch?: string; instructions?: string; repo?: string }`. Branch defaults to the Macro convention `jarvis/T-<number>-<slug>` (`PLAN.md:525`, number from `task.number`, `graph.ts:96`).

## Execution model
1. **Worktree manager** (`packages/modules/src/code/worktree.ts`) — wraps `git worktree add/remove` via `node:child_process` (the only sanctioned use; today child_process is used only for Chrome launch / schtasks / backup, never for agent code — this is new and must be workdir-locked).
2. **Runner** (`packages/modules/src/code/runner.ts`) — runs the coding agent inside the worktree. Reuse the existing brain (`packages/jarvis/src/brains/claude.ts`, Claude Agent SDK via the `claude` CLI) pointed at the worktree cwd, OR shell to a coding CLI. Streams progress to the task thread using the existing **`stream` SSE channel** (`apps/server/src/routes/events.ts:57`) and `conversation_log` (`jarvis.ts:39`).
3. **Run record** — new table `code_run` in `packages/db` (`id, taskId, branch, repo, worktreePath, status∈queued|running|done|failed|canceled, startedAt, finishedAt, commitShas text[], error, correlationId`). Link to the task via the existing `<m-ref>`/entity-link pattern so it shows in the task thread and the Activity View (Spec 1).

## Files to add / change
- **add** `packages/modules/src/code/{index.ts, actions.ts, worktree.ts, runner.ts}`
- **add** `code_run` table + migration in `packages/db/src/schema/`
- **register** the module in `apps/jarvis/src/main.ts` and `apps/worker/src/main.ts`
- **settings** (`packages/kernel/src/settings.ts`): `code.worktreeRoot`, `code.allowedRepos`, `code.enabled` (default off — opt-in, like Nook WM)
- **web**: a run panel in the task thread + surface runs in `Activity.tsx` (Spec 1); reuse the `stream` channel the web already consumes (`apps/web/src/lib/live.ts`)
- **prompt**: a handoff template (task, branch, comment history, conventions) — the "Macro handoff prompt" referenced in PLAN

## Decisions to settle before building
1. **Runner engine** — reuse the Claude Agent SDK brain in the worktree cwd, or shell out to a dedicated coding CLI? (Reuse is less new surface.)
2. **Repo scope** — which repos are in `code.allowedRepos`? Default-exclude live Hearth; opt in per repo.
3. **How much autonomy** — does `code.start` require your approval each time (safest, recommended first), or may Pip self-start for tasks assigned to it under a standing rule?
4. **Worktree lifecycle** — auto-cleanup on merge vs. keep for inspection (recommend keep, `code.cleanup` manual).

## Why this is safe-by-construction
It adds zero new trust paths: code actions are ordinary kernel actions, so policy (`policy.ts` agent→outward→ask), approvals, audit, taint, and the "would the owner be upset if this ran while asleep?" rule all apply unchanged. The only genuinely new thing is a workdir-locked subprocess — contained to a throwaway worktree, never pushing on its own.
