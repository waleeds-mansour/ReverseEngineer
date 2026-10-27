-- Back to one inbox: the bundles, and which ones were moved by hand, are forgotten. Going up
-- again sorts every conversation afresh, by sync.
DROP INDEX IF EXISTS mail_thread_unsorted;
DROP INDEX IF EXISTS mail_thread_inbox_bundle;
ALTER TABLE mail_thread
  DROP COLUMN IF EXISTS bundle_moved,
  DROP COLUMN IF EXISTS bundle;
