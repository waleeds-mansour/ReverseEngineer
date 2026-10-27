// 0058_mail_bundles on a database with mail in it: conversations from before have no bundle, for
// sync to sort; only the four bundles go in; the inbox query by bundle has its index; and down
// and up again leaves the mail itself as it was.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

const q = (sql: string, params: unknown[] = []) => tdb.pool.query(sql, params);
const NAME = "0058_mail_bundles";
const SINCE = loadMigrations()
  .map((m) => m.name)
  .filter((n) => n >= NAME);
const down = async () =>
  expect(await migrateDown(tdb.pool, SINCE.length)).toEqual([...SINCE].reverse());
const up = async () => expect(await migrateUp(tdb.pool)).toEqual(SINCE);

const LUNCH = "00000000-0000-7000-8000-0000000000b1";
const GITHUB = "00000000-0000-7000-8000-0000000000b2";

const columns = async () =>
  (
    await q(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'mail_thread' AND column_name LIKE 'bundle%' ORDER BY column_name",
    )
  ).rows.map((r: { column_name: string }) => r.column_name);

const indexes = async () =>
  (
    await q(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'mail_thread' AND indexname IN ('mail_thread_inbox_bundle', 'mail_thread_unsorted') ORDER BY indexname",
    )
  ).rows.map((r: { indexname: string }) => r.indexname);

describe(NAME, () => {
  it("leaves conversations from before unsorted, for sync to sort", async () => {
    await down();
    expect(await columns()).toEqual([]);
    await q(
      "INSERT INTO mail_account (id, provider, address) VALUES ('gmail:me@example.com', 'gmail', 'me@example.com')",
    );
    await q(
      "INSERT INTO entity (id, type, title, created_by, updated_by) VALUES ($1, 'email_thread', 'Lunch?', 'integration:google', 'integration:google'), ($2, 'email_thread', '[repo] PR #1', 'integration:google', 'integration:google')",
      [LUNCH, GITHUB],
    );
    await q(
      "INSERT INTO mail_thread (entity_id, account_id, root_message_id, last_message_at, in_inbox) VALUES ($1, 'gmail:me@example.com', 'a@x', now(), true), ($2, 'gmail:me@example.com', 'b@x', now(), true)",
      [LUNCH, GITHUB],
    );
    await up();
    expect(await columns()).toEqual(["bundle", "bundle_moved"]);
    expect(await indexes()).toEqual(["mail_thread_inbox_bundle", "mail_thread_unsorted"]);
    expect(
      (await q("SELECT bundle, bundle_moved FROM mail_thread ORDER BY entity_id")).rows,
    ).toEqual([
      { bundle: null, bundle_moved: false },
      { bundle: null, bundle_moved: false },
    ]);
  });

  it("takes only the four bundles", async () => {
    for (const bundle of ["people", "updates", "receipts", "newsletters"])
      await q("UPDATE mail_thread SET bundle = $1 WHERE entity_id = $2", [bundle, LUNCH]);
    await expect(
      q("UPDATE mail_thread SET bundle = 'spam' WHERE entity_id = $1", [LUNCH]),
    ).rejects.toThrow(/mail_thread_bundle_check/);
    await q("UPDATE mail_thread SET bundle = NULL WHERE entity_id = $1", [LUNCH]);
  });

  it("counts a conversation not sorted yet with People, through the index's own expression", async () => {
    await q("UPDATE mail_thread SET bundle = 'updates', bundle_moved = true WHERE entity_id = $1", [
      GITHUB,
    ]);
    const rows = await q(
      "SELECT coalesce(bundle, 'people') AS bundle, count(*)::int AS n FROM mail_thread WHERE in_inbox AND NOT trashed GROUP BY 1 ORDER BY 1",
    );
    expect(rows.rows).toEqual([
      { bundle: "people", n: 1 },
      { bundle: "updates", n: 1 },
    ]);
  });

  it("goes down and up again, keeping the mail and forgetting the sorting", async () => {
    await down();
    expect(await columns()).toEqual([]);
    expect(await indexes()).toEqual([]);
    expect((await q("SELECT count(*)::int AS n FROM mail_thread")).rows).toEqual([{ n: 2 }]);
    await up();
    expect(
      (await q("SELECT bundle, bundle_moved FROM mail_thread ORDER BY entity_id")).rows,
    ).toEqual([
      { bundle: null, bundle_moved: false },
      { bundle: null, bundle_moved: false },
    ]);
  });
});
