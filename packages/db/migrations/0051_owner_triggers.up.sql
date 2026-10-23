-- Your triggers (Spec 6): when something of a kind you picked happens (an email from someone, a
-- Notion ticket that's yours), Pip does what you wrote, in a turn of its own. The event-keyed
-- sibling of your routines: one compiled reflex (trigger.fire) looks these rows up. Called
-- owner_trigger, since TRIGGER is SQL's own word.
CREATE TABLE owner_trigger (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  -- The event kind it waits for, from the short list Settings offers (never plumbing).
  event_kind text NOT NULL,
  -- Payload fields that must equal these values (case aside), all of them; {} matches every one.
  filter jsonb NOT NULL DEFAULT '{}',
  -- What to do, in your words. Never taken from outside content.
  instructions text NOT NULL,
  -- The job its turns run for (Spec 3), within its ceiling and turns a day.
  role_id uuid REFERENCES role (id) ON DELETE SET NULL,
  -- The most turns it starts in a day, so a burst of email can't spend Pip's day.
  per_day integer NOT NULL DEFAULT 10 CHECK (per_day BETWEEN 1 AND 50),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX owner_trigger_name ON owner_trigger (lower(name));
CREATE INDEX owner_trigger_kind ON owner_trigger (event_kind) WHERE active;

-- A trigger's turns: their own kind, so What Pip did can name the trigger that set them off.
ALTER TABLE jarvis_turn DROP CONSTRAINT jarvis_turn_trigger_check;
ALTER TABLE jarvis_turn ADD CONSTRAINT jarvis_turn_trigger_check CHECK (trigger IN (
  'chat', 'mention', 'assignment', 'approval', 'watch', 'reflex', 'routine', 'voice_command',
  'slack_member', 'trigger'
));
-- How many turns each trigger started today, for its cap and for Settings.
CREATE INDEX jarvis_turn_owner_trigger ON jarvis_turn ((context ->> 'triggerId'), queued_at)
  WHERE trigger = 'trigger';
