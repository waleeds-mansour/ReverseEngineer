ALTER TABLE person DROP COLUMN IF EXISTS persona_at, DROP COLUMN IF EXISTS persona;
ALTER TABLE slack_user
  DROP COLUMN IF EXISTS time_zone,
  DROP COLUMN IF EXISTS title,
  DROP COLUMN IF EXISTS display_name;
DROP INDEX IF EXISTS slack_message_thread;
ALTER TABLE slack_message DROP COLUMN IF EXISTS mentions;
DROP INDEX IF EXISTS slack_message_people;
ALTER TABLE slack_message DROP COLUMN IF EXISTS people_linked;
