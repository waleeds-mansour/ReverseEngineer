DELETE FROM link l
USING entity t, entity n
WHERE l.kind = 'derived_from'
  AND t.id = l.from_id AND t.type = 'task'
  AND n.id = l.to_id AND n.type = 'notion_task';
ALTER TABLE notion_task DROP COLUMN closed_at;
