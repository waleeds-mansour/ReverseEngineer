-- The choice Pip would pick (D85): when one of a question's choices is clearly better, Pip says
-- which, by its place in the list (from 0), and why in `why`; the Inbox shows it as Recommended.
-- Most questions have none. It always names a choice the question has, so a card can't point
-- past the end of its list.
ALTER TABLE question
  ADD COLUMN recommended smallint,
  ADD CONSTRAINT question_recommended CHECK (
    recommended IS NULL OR (recommended >= 0 AND recommended < jsonb_array_length(choices))
  );
