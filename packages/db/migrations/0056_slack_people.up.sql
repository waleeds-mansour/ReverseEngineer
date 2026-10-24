-- People from Slack. Someone you've talked with directly (a DM or a group DM, a thread you both
-- wrote in, an @mention either way) becomes a person, by their Slack email. Each Slack message is
-- looked at once for that: everything read in before this is looked at on the next rounds.
ALTER TABLE slack_message ADD COLUMN people_linked boolean NOT NULL DEFAULT false;
CREATE INDEX slack_message_people ON slack_message (sent_at) WHERE NOT people_linked;
-- Who a message @mentions, by Slack id, from its own text: Hearth keeps only the names. Messages
-- read in before this have none.
ALTER TABLE slack_message ADD COLUMN mentions text[];
-- A thread's replies, found by its start.
CREATE INDEX slack_message_thread ON slack_message (channel_id, thread_ts) WHERE thread_ts IS NOT NULL;

-- What their Slack profile says: the name they go by, their title and their time zone.
ALTER TABLE slack_user
  ADD COLUMN display_name text,
  ADD COLUMN title text,
  ADD COLUMN time_zone text;

-- Pip's few lines about someone, written from your Slack messages together. Their words are in
-- it, so it's outside content (D58), and it's kept apart from your own notes on them.
ALTER TABLE person
  ADD COLUMN persona text,
  ADD COLUMN persona_at timestamptz;
