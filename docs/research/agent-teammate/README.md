# Research: agent teammates (OpenAI dots, xAI Grok Bot)

Written 2026-10-22. dots and Grok Bot were studied from their launch pages, and each spec says
which claims it builds on. Spec 7 comes from the Morgen research ([../morgen.md](../morgen.md)).
Spec 8 comes from Hearth's own calendar code and the providers' public docs (RFC 4791 and
Microsoft Graph's).

**Verdict: both arrived at the shape Pip already has.** An always-on agent, a proactive loop,
memory, an approval gate and browser control. What's worth taking is a short list of gaps, below.

## The files
- [plan.md](plan.md): the overall plan, Pip next to dots and Grok Bot, and six tracks.
- [spec-1-activity-view.md](spec-1-activity-view.md): "What Pip did, and why". To build first.
- [spec-2-code-worktree.md](spec-2-code-worktree.md): Pip's code work in a native git worktree.
- [spec-3-pip-jobs.md](spec-3-pip-jobs.md): jobs, role-scoped profiles for one Pip. Built, as
  `role` in code.
- [spec-4-connect-tool.md](spec-4-connect-tool.md): a Connect card mid-task, then Pip picks it up again.
- [spec-5-readonly-background-mode.md](spec-5-readonly-background-mode.md): background turns capped at read and internal.
- [spec-6-event-workflows.md](spec-6-event-workflows.md): "when X happens, do Y" triggers you write.
- [spec-7-day-planner.md](spec-7-day-planner.md): one plan for your day, held until you approve it.
- [spec-8-calendar-providers.md](spec-8-calendar-providers.md): one calendar interface, with Google
  as its first adapter and Microsoft Graph and CalDAV after it.

Specs 2, 6, 7 and 8 are designs only for now. The plan numbers its tracks differently from the
specs: its Track 4 is Spec 2, and its Tracks 2 (learn by demonstration), 3 (rules you edit) and 5
(several agents) have no spec yet.

## Build order
**1, then 5, 3, 4, 6.** Specs 1, 5, 4 and 3 are built; Spec 6 is next. Spec 2 fits in whenever
code work is wanted, and Spec 7 any time after 1.
- Spec 5 comes before Spec 3: a job's risk ceiling reuses Spec 5's check in `decide()`
  (`packages/kernel/src/policy.ts`). Built that way: both are a `Hold` there.
- Spec 1 comes first because 4, 5 and 6 hold or chain actions, which you can't see without it.
- Spec 7's re-plan reflex is an ordinary compiled reflex, so it doesn't wait for Spec 6.
- Spec 8 doesn't wait on the others. Its first phase moves Google behind the interface and changes
  nothing you can see. Its Connect card for a missing calendar needs Spec 4.

## Rules these keep
- D8 (`docs/decisions.md`): Pip is never containerized, so code work is a native worktree.
- Pip acts outside Hearth through its browser only: no screen capture, OCR or desktop control.

## Spec 1 and Pip's desk
Spec 1 is built together with "Pip's desk", the first idea in the 2026-10-22 Claude Duet research:
a card for what Pip is working on now, and a list of what it made. Both read the same records
(`jarvis_turn`, `approval`, `audit`), so they're one view.
