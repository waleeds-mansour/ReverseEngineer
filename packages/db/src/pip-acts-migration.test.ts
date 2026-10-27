// 0057_pip_acts_on_its_own (the owner, 2026-10-27): an install whose background work was set to
// read-only is on again, like a new one. Whether Pip is paused is yours, and stays.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

const q = (sql: string, params: unknown[] = []) => tdb.pool.query(sql, params);
const NAME = "0057_pip_acts_on_its_own";
const SINCE = loadMigrations()
  .map((m) => m.name)
  .filter((n) => n >= NAME);

const set = (key: string, value: unknown) =>
  q("INSERT INTO setting (key, value) VALUES ($1, $2)", [key, JSON.stringify(value)]);
const settings = async () =>
  (
    await q(
      "SELECT key, value FROM setting WHERE key IN ('jarvis.backgroundReadOnly', 'jarvis.paused') ORDER BY key",
    )
  ).rows as { key: string; value: unknown }[];

describe(NAME, () => {
  it("turns background read-only off, and leaves a pause alone", async () => {
    expect(await migrateDown(tdb.pool, SINCE.length)).toEqual([...SINCE].reverse());
    await set("jarvis.backgroundReadOnly", true);
    await set("jarvis.paused", true);
    await migrateUp(tdb.pool);
    expect(await settings()).toEqual([{ key: "jarvis.paused", value: true }]);
    // Down and up again changes nothing more.
    await migrateDown(tdb.pool, SINCE.length);
    await migrateUp(tdb.pool);
    expect(await settings()).toEqual([{ key: "jarvis.paused", value: true }]);
  });
});
