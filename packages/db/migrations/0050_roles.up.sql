-- Pip's jobs (Spec 3): an owner-defined profile that only ever narrows what Pip does. A job bundles
-- some of your routines and Pip's proactive reflexes, caps what their turns may do at a risk, can
-- give them a daily turn allowance of their own, and adds a few lines to their prompt. It's still
-- one Pip: no new process and no new concurrency. Called "role" in code, since D82 already uses
-- "job" for model tiers.
CREATE TABLE role (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  -- A few lines added to its turns' prompt, in your words.
  persona_note text,
  -- The most its turns may do. A call above it is held for your brief, like Spec 5's read-only.
  risk_ceiling text NOT NULL DEFAULT 'read'
    CHECK (risk_ceiling IN ('read', 'internal', 'self_external', 'outward')),
  -- Its own turns a day, inside the global allowance; null shares the global one alone.
  turns_per_day integer CHECK (turns_per_day IS NULL OR turns_per_day >= 0),
  -- Off pauses everything attached to it.
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX role_name ON role (lower(name));

-- Which of your routines belong to a job. A routine is in one job at most.
CREATE TABLE role_routine (
  routine_id uuid PRIMARY KEY REFERENCES routine (entity_id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES role (id) ON DELETE CASCADE
);
CREATE INDEX role_routine_role ON role_routine (role_id);

-- Which of Pip's proactive reflexes belong to a job, by name. A reflex is in one job at most.
CREATE TABLE role_reflex (
  reflex_name text PRIMARY KEY,
  role_id uuid NOT NULL REFERENCES role (id) ON DELETE CASCADE
);
CREATE INDEX role_reflex_role ON role_reflex (role_id);

-- The job a turn ran for, so its ceiling and allowance apply and What Pip did can filter by it.
ALTER TABLE jarvis_turn ADD COLUMN role_id uuid REFERENCES role (id) ON DELETE SET NULL;
CREATE INDEX jarvis_turn_role ON jarvis_turn (role_id, queued_at) WHERE role_id IS NOT NULL;

-- The worked example: nothing is attached, so it changes nothing until you attach something.
INSERT INTO role (id, name, description, persona_note, risk_ceiling)
VALUES (
  '7e5ea2c4-3a1b-4c8e-9d2f-5b6a7c8d9e01',
  'Research',
  'Looks things up and tells you what it found. It changes nothing.',
  'You are doing research. Read widely, say where each finding came from, and keep it short.',
  'read'
);
