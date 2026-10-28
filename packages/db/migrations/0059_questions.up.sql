-- Pip asks with choices (D85): when a decision is the owner's and has two or three clear options,
-- Pip leaves a question with numbered choices instead of asking in its reply, and its turn ends
-- there. The owner picks one (or writes their own) from the inbox, and Pip is started again in the
-- same conversation with the answer. A question nobody answers lapses after a few days.
CREATE TABLE question (
  id uuid PRIMARY KEY,
  -- Where Pip asked, and where its work picks up again.
  conversation_id uuid NOT NULL REFERENCES conversation (entity_id) ON DELETE CASCADE,
  -- The turn that asked: the work picks up again in its lane and job. Kept like an approval's.
  turn_id uuid NOT NULL,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 300),
  -- Two or three short strings; an answer names one by its place in this list (from 0).
  choices jsonb NOT NULL CHECK (
    CASE WHEN jsonb_typeof(choices) = 'array' THEN jsonb_array_length(choices) BETWEEN 2 AND 3
    ELSE false END
  ),
  -- Why Pip asks, in a sentence, when it said.
  why text,
  -- As trusted as the asking turn was: one that read outside content may have been steered, so
  -- its card says so and the work it picks up again is no more trusted than that (D58).
  origin text NOT NULL CHECK (origin IN ('owner', 'agent', 'untrusted', 'system')),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired')),
  -- {choice?: number, text?: string}: the choice picked and/or the owner's own words.
  answer jsonb,
  answered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT question_answered CHECK (
    (status = 'answered') = (answer IS NOT NULL AND answered_at IS NOT NULL)
  )
);
-- What's still waiting for the owner, oldest first (listOpenQuestions). A turn asks at most once:
-- its turn ends there, so a second open question from it would be a second answer to wait on.
CREATE INDEX question_open ON question (created_at) WHERE status = 'open';
CREATE UNIQUE INDEX question_open_turn ON question (turn_id) WHERE status = 'open';
CREATE INDEX question_conversation ON question (conversation_id);

-- Finished-work cards (D85) skip a turn that already put a card in the inbox (a brief, a
-- question, anything it told you): its cards are found by the turn's correlation id, among the
-- only events that matter here.
CREATE INDEX event_notification_correlation ON event (correlation_id)
  WHERE kind = 'notification.created';
