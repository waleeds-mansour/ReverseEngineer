DROP INDEX jarvis_turn_owner_trigger;
-- A trigger's past turns stay in the history, as the reflex turns they were before Spec 6.
UPDATE jarvis_turn SET trigger = 'reflex' WHERE trigger = 'trigger';
ALTER TABLE jarvis_turn DROP CONSTRAINT jarvis_turn_trigger_check;
ALTER TABLE jarvis_turn ADD CONSTRAINT jarvis_turn_trigger_check CHECK (trigger IN (
  'chat', 'mention', 'assignment', 'approval', 'watch', 'reflex', 'routine', 'voice_command',
  'slack_member'
));
DROP TABLE owner_trigger;
