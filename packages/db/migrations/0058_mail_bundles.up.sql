-- Mail bundles (L2-04): each conversation sorts into People (real conversations), Updates
-- (notifications, shipping, accounts), Receipts (orders, invoices, payments) or Newsletters
-- (lists, marketing), so the inbox reads like a person's. Sorted by rules over what Nook already
-- keeps (modules' mail/bundles.ts), never a model call per email. A conversation from before this
-- has no bundle until sync sorts it, a batch a round; until then it shows with People, so nothing
-- leaves the inbox while it sorts.
ALTER TABLE mail_thread
  ADD COLUMN bundle text CONSTRAINT mail_thread_bundle_check
    CHECK (bundle IN ('people', 'updates', 'receipts', 'newsletters')),
  -- Moved by hand, by you or by Pip sorting for you: sync never sorts it again.
  ADD COLUMN bundle_moved boolean NOT NULL DEFAULT false;

-- The inbox a bundle at a time, newest first (mail.threads), and each bundle's count
-- (mail.bundles). Not sorted yet counts as People, the same way the queries say it.
CREATE INDEX mail_thread_inbox_bundle
  ON mail_thread ((coalesce(bundle, 'people')), last_message_at DESC, entity_id DESC)
  WHERE in_inbox AND NOT trashed;

-- What's still to sort, by account, as each account's sync sorts its own.
CREATE INDEX mail_thread_unsorted ON mail_thread (account_id) WHERE bundle IS NULL;
