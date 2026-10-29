-- Back to questions without a recommended choice: the questions and their answers stay, only
-- which choice Pip recommended is forgotten.
ALTER TABLE question DROP COLUMN IF EXISTS recommended;
