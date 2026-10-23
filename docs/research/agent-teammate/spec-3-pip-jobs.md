# Spec 3 — Pip "jobs": role-scoped profiles · BUILT (2026-10-23)

> **As built.** The owner asked for it on 2026-10-23, with the recommendations below settled:
> jobs run concurrently and tag their turns, the trust scope is one `riskCeiling`, and "Research"
> (capped at `read`) is seeded. In code a job is a **role**, because D82 already calls model tiers
> "jobs" (`packages/jarvis/src/models.ts`): tables `role`, `role_routine` and `role_reflex`
> (migration 0050), `jarvis_turn.role_id`, actions `role.create/update/attach/detach/list/remove`
> (`packages/modules/src/roles/`). The UI still says "Pip's jobs" (Settings, and a filter and label
> in What Pip did). Where the build differs from the design below:
> - **The ceiling is a `Hold` in `decide()`**, beside Spec 5's: `holdsFor` (`kernel/src/guard.ts`)
>   reads the turn's job for every call, so a change applies at once. A call past it is refused,
>   noted for the brief (`jarvis/src/held.ts`) and shown as "Held for your brief" in What Pip did.
>   What only reports (`jarvis.observe`, `inbox.notify`, `comment.create`, marked `reports`) stays
>   within any ceiling, so a job that only reads can still say what it found. `outward` still holds
>   what's hard to undo.
> - **A job is a plain table, not an entity**: it's configuration, like a data source. Removing one
>   deletes it; its routines and reflexes stay and run as before, and its past turns lose the label.
> - **Its allowance is `turns_per_day`**, counting all its turns, its routines' (reactive) too, and
>   it never lets a turn past the global proactive allowance.
> - **Only proactive reflexes** can be in a job, and each routine or reflex is in one job at most.
>   A job that's off pauses them; Run now still runs a routine.
> - **Pip can make and tighten a job, but only you can loosen one** (a higher ceiling, more turns,
>   back on, or moving something out of another job); taking something out and removing a job are
>   yours alone.
> - The job follows its work when it's picked up again: after your answer to its approval, and
>   after you connect what it needed (Spec 4).

> **Source / provenance:** from **both** pages — Grok **Bot** ("give each Bot a job"; a billing/sales/research Bot) and ChatGPT **dots** ("specialist dots" for a domain). Both are *marketing claims*, not reverse-engineered. The realization below — a single-agent profile that scopes routines/reflexes/trust/budget, **no extra agent process** — is Hearth-native and deliberately avoids the multi-agent path (that's Track 5, deferred for reliability).

## The idea, honestly scoped
Grok/dots pitch "a Bot per job" as *many agents*. The valuable, reliability-safe half is the **profile**, not the extra process: a named bundle that says *"when you're doing the Sales job, these routines run, these reflexes are live, you may act within this trust scope, under this budget, with this persona slant."* One Pip, many jobs — not many Pips. This keeps D62's 2-worker queue intact (no new concurrency) while giving the owner the "assign Pip a role" feeling.

## What a job *is* (bundle of things that already exist)
A **job** = an owner-defined row that references:
1. **Routines** — a subset of the dynamic `routine` rows (`packages/db/src/schema/vault.ts:22-28`) and/or compiled `RoutineDef`s (`packages/kernel/src/types.ts:274-282`) that belong to this job.
2. **Reflexes** — which proactive reflexes are *on* for this job (today `registry.reflexesFor(kind)` returns **all** matching reflexes globally — `packages/jarvis/src/engine.ts:71`; a job scopes that set).
3. **Trust scope** — a standing-rule set + a risk ceiling (reuses `always-allow.ts` + `policy.ts`; e.g. the "Research" job is capped at `read`, the "Inbox" job may go to `outward` with your rules).
4. **Budget slice** — its own proactive-turn allowance, mirroring `jarvis.proactiveTurnsPerDay` (`settings.ts`, default 60) so a runaway job can't starve the others.
5. **Persona addendum** — a few lines appended to the turn prompt (`prompts/jarvis.md`), so "Sales Pip" frames its replies differently. Cosmetic, last.

## Data model (mirror the `routine` table, which is the proven dynamic pattern)
```
job            (entityId pk, name, description, personaNote text|null,
                riskCeiling ∈ read|internal|self_external|outward,  -- hard cap for this job's turns
                proactiveTurnsPerDay int|null,                       -- null = share the global budget
                active bool default true)
job_routine    (jobId, routineId)         -- which routines belong to the job
job_reflex     (jobId, reflexName)         -- which compiled/dynamic reflexes are live for the job
```
`job` sits beside `routine` in `packages/db/src/schema/vault.ts`. No change to how turns *execute* — only which fire and under what ceiling.

## How a job threads through a turn (the one real wiring change)
Every queued `jarvis_turn` already carries `trigger`, `mode`, `lane`, `context` (`packages/db/src/schema/jarvis.ts:68`). Add **`jobId`** to the turn row and to the `ReflexOutcome` `turn` variant (`types.ts:191-224`). Then:
- **At fire time:** when a routine/reflex that belongs to a job emits a `turn` outcome (`packages/jarvis/src/outcomes.ts:113-124`), tag it with the job's `jobId`.
- **At run time:** the job's `riskCeiling` becomes a cap on that turn's calls — enforced at the **same chokepoint as Spec 5**: thread it into the `Caller` (`packages/kernel/src/types.ts:8-37`) and check it in `decide()`'s agent branch (`packages/kernel/src/policy.ts:52-69`). (Specs 3 and 5 share this one insertion point — build 5 first, 3 reuses it.)
- **Budget:** `proactiveGate` (`packages/jarvis/src/budget.ts`) reads a per-job count when `jobId` is set, else the global one.
- **Activity View (Spec 1):** group/filter by `jobId` so "what did the Sales job do today" is one click. This is where jobs become *visible*, which is the owner's #1 ask.

## New kernel actions (module `packages/modules/src/jobs/`, shaped like `routines/`)
Follow `routines/index.ts:148-257` exactly (same risks, same `refuseUntrusted` guard at `:29-35`):

| Action | risk | callers | Purpose |
|---|---|---|---|
| `job.create` | `internal` | owner, agent | `{ name, description, personaNote?, riskCeiling?, proactiveTurnsPerDay? }` |
| `job.update` | `internal` | owner, agent | rename / re-scope / activate |
| `job.attach` | `internal` | owner, agent | add a routine or reflex to a job (`job_routine`/`job_reflex` upsert) |
| `job.detach` | `internal` | owner, agent | remove one |
| `job.list` | `read` | owner, agent | for Settings + Activity filter |
| `job.remove` | `internal` | owner | trash the job (routines survive, just un-bundled) |

Register in `apps/jarvis/src/main.ts` + `apps/worker/src/main.ts`; `Registry.checkJarvisContract` enforces `module.verb` naming.

## Why this is safe-by-construction
A job can only ever **narrow** what Pip does: fewer reflexes on, a lower risk ceiling, a smaller budget. It adds no new capability and no new trust path — every call still goes through `kernel.execute → decide()`. The worst a misconfigured job does is run *less*. (Contrast with Track 5 multi-agent, which adds concurrency and is why that one is deferred.)

## Decisions to settle before building
1. **Concurrent or switched?** Do all jobs run live at once (each turn tagged), or does the owner "put Pip on" one job at a time? Recommend **concurrent + tagged** — it's how the engine already works (reflexes all fire); switching would mean pausing reflex sets, more state.
2. **Ceiling vs. rules.** Is a job's trust scope a single `riskCeiling` enum (simple, recommended v1) or a full per-action standing-rule set (powerful, but that's really Track 3's Custom-Rules surface — let jobs *reference* a rule set once Track 3 ships)?
3. **Seed jobs.** Ship 2–3 defaults (Inbox, Research-read-only, Calendar) or start empty and let the owner define them? Recommend 1 seed ("Research", `riskCeiling: read`) as the worked example — it doubles as the Spec-5 demo.
4. **Depends on Spec 5** for the ceiling enforcement point. Build order: Spec 5 (read-only cap) → Spec 3 (jobs reuse the cap, generalized to any ceiling).

## Risk / effort
Medium. One table pair + one `jobId` column + one module (copy of `routines/`) + reuse of the Spec-5 policy hook + an Activity filter. No execution/concurrency change. Independently shippable after Spec 5.
