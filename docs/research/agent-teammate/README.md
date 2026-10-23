# Research: agent teammates (OpenAI dots, xAI Grok Bot)

Written 2026-10-22. dots and Grok Bot were studied from their launch pages and, for their desktop
clients, with the REA tool. Nearly every pattern here comes from the launch pages, and each spec
says which. Only the clients were visible: the agents themselves run on the vendors' servers.

**Verdict: both arrived at the shape Pip already has.** An always-on agent, a proactive loop,
memory, an approval gate and browser control. What's worth taking is a short list of gaps, below.

## The files
- [plan.md](plan.md): the overall plan, Pip next to dots and Grok Bot, and six tracks.
- [spec-1-activity-view.md](spec-1-activity-view.md): "What Pip did, and why". To build first.
- [spec-2-code-worktree.md](spec-2-code-worktree.md): Pip's code work in a native git worktree.
- [spec-3-pip-jobs.md](spec-3-pip-jobs.md): jobs, role-scoped profiles for one Pip.
- [spec-4-connect-tool.md](spec-4-connect-tool.md): a Connect card mid-task, then Pip picks it up again.
- [spec-5-readonly-background-mode.md](spec-5-readonly-background-mode.md): background turns capped at read and internal.
- [spec-6-event-workflows.md](spec-6-event-workflows.md): "when X happens, do Y" triggers you write.

Specs 2 to 6 are designs only. The plan numbers its tracks differently from the specs: its
Track 4 is Spec 2, and its Tracks 2 (learn by demonstration), 3 (rules you edit) and 5 (several
agents) have no spec yet.

## Build order
**1, then 5, 3, 4, 6.** Spec 2 fits in whenever code work is wanted.
- Spec 5 comes before Spec 3: a job's risk ceiling reuses Spec 5's check in `decide()`
  (`packages/kernel/src/policy.ts`).
- Spec 1 comes first because 4, 5 and 6 hold or chain actions, which you can't see without it.

## Rules these keep
- D8 (`docs/decisions.md`): Pip is never containerized, so code work is a native worktree.
- Pip acts outside Hearth through its browser only. Grok Bot's screen capture, OCR and process
  list are not adopted.

## Spec 1 and Pip's desk
Spec 1 is built together with "Pip's desk", the first idea in the 2026-10-22 Claude Duet research:
a card for what Pip is working on now, and a list of what it made. Both read the same records
(`jarvis_turn`, `approval`, `audit`), so they're one view.
