-- Notion tickets and the tasks made from them (Connections-16).
-- When Hearth last saw a ticket close or leave you, by its own clock. Catch-up closes the task again
-- only when nothing touched it since, so a task you reopened stays open.
ALTER TABLE notion_task ADD COLUMN closed_at timestamptz;

-- A task made from a ticket links to it as derived_from, which editing the task's words can't
-- remove. Until now the only link was the "From" mention in its body. Hearth or Jarvis made those
-- tasks from the ticket's news, marked outside, and the mention is theirs too.
INSERT INTO link (id, from_id, to_id, kind, anchor, created_by, created_at)
SELECT gen_random_uuid(), l.from_id, l.to_id, 'derived_from', '', 'system', now()
FROM link l
JOIN entity t ON t.id = l.from_id
JOIN entity n ON n.id = l.to_id
WHERE l.kind = 'mention'
  AND l.created_by IN ('system', 'jarvis')
  AND t.type = 'task'
  AND t.outside
  AND t.created_by IN ('system', 'jarvis')
  AND n.type = 'notion_task'
ON CONFLICT DO NOTHING;
