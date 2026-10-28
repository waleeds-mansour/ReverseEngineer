// 0059_questions: a question takes two or three choices, says answered only with an answer, goes
// with its conversation, and the finished-work check finds a turn's cards by an index of its own.
// Down and up again leaves the conversations and the event log as they were.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadMigrations, migrateDown, migrateUp } from "./migrate.ts";
import { createTestDatabase, type TestDatabase } from "./testing/index.ts";

let tdb: TestDatabase;
beforeAll(async () => {
  tdb = await createTestDatabase();
});
afterAll(() => tdb.destroy());

const q = (sql: string, params: unknown[] = []) => tdb.pool.query(sql, params);
const NAME = "0059_questions";
const SINCE = loadMigrations()
  .map((m) => m.name)
  .filter((n) => n >= NAME);
const down = async () =>
  expect(await migrateDown(tdb.pool, SINCE.length)).toEqual([...SINCE].reverse());
const up = async () => expect(await migrateUp(tdb.pool)).toEqual(SINCE);

const CHAT = "00000000-0000-7000-8000-0000000000c1";
const TURN = "00000000-0000-7000-8000-0000000000c2";
const Q = "00000000-0000-7000-8000-0000000000c3";

const ask = (choices: unknown, extra = "") =>
  q(
    `INSERT INTO question (id, conversation_id, turn_id, question, choices, origin, expires_at${extra ? ", status, answer, answered_at" : ""})
     VALUES ($1, $2, $3, 'Which day?', $4, 'owner', now() + interval '3 days'${extra})`,
    [Q, CHAT, TURN, JSON.stringify(choices)],
  );

const tables = async () =>
  (
    await q(
      "SELECT to_regclass('question') AS t, to_regclass('event_notification_correlation') AS i",
    )
  ).rows[0];

describe(NAME, () => {
  it("goes up over conversations from before", async () => {
    await down();
    expect(await tables()).toEqual({ t: null, i: null });
    await q(
      "INSERT INTO entity (id, type, title, created_by, updated_by) VALUES ($1, 'conversation', 'Dentist', 'owner', 'owner')",
      [CHAT],
    );
    await q("INSERT INTO conversation (entity_id) VALUES ($1)", [CHAT]);
    await up();
    expect(await tables()).toEqual({ t: "question", i: "event_notification_correlation" });
  });

  it("takes two or three choices, and says answered only with an answer", async () => {
    await expect(ask(["Friday"])).rejects.toThrow(/question_choices_check/);
    await expect(ask(["a", "b", "c", "d"])).rejects.toThrow(/question_choices_check/);
    await expect(ask({ a: 1 })).rejects.toThrow(/question_choices_check/);
    await expect(ask(["Friday", "Monday"], ", 'answered', NULL, NULL")).rejects.toThrow(
      /question_answered/,
    );
    await ask(["Friday", "Monday"]);
    const row = (await q("SELECT status, answer FROM question WHERE id = $1", [Q])).rows[0];
    expect(row).toEqual({ status: "open", answer: null });
    await expect(q("UPDATE question SET status = 'maybe' WHERE id = $1", [Q])).rejects.toThrow(
      /question_status_check/,
    );
    await q(
      `UPDATE question SET status = 'answered', answer = '{"choice":1}', answered_at = now() WHERE id = $1`,
      [Q],
    );
  });

  it("keeps a turn to a single open question", async () => {
    const open = (id: string, turn = TURN) =>
      q(
        `INSERT INTO question (id, conversation_id, turn_id, question, choices, origin, expires_at)
         VALUES ($1, $2, $3, 'Which room?', '["A", "B"]', 'owner', now() + interval '3 days')`,
        [id, CHAT, turn],
      );
    // Its first question is answered, so it may have another waiting, but not two.
    await open("00000000-0000-7000-8000-0000000000d1");
    await expect(open("00000000-0000-7000-8000-0000000000d2")).rejects.toThrow(
      /question_open_turn/,
    );
    await open("00000000-0000-7000-8000-0000000000d3", "00000000-0000-7000-8000-0000000000d4");
    await q("DELETE FROM question WHERE id <> $1", [Q]);
  });

  it("finds a turn's cards in the event log by the turn", async () => {
    const c = await tdb.pool.connect();
    try {
      // A small table is scanned whatever its indexes: this asks whether the index can serve.
      await c.query("SET enable_seqscan = off");
      const plan = await c.query(
        "EXPLAIN SELECT seq FROM event WHERE correlation_id = $1 AND kind = 'notification.created' LIMIT 1",
        [TURN],
      );
      const text = plan.rows.map((r: Record<string, string>) => Object.values(r)[0]).join("\n");
      expect(text).toContain("event_notification_correlation");
    } finally {
      await c.query("RESET enable_seqscan");
      c.release();
    }
  });

  it("goes with its conversation", async () => {
    await q("DELETE FROM conversation WHERE entity_id = $1", [CHAT]);
    expect((await q("SELECT count(*)::int AS n FROM question")).rows).toEqual([{ n: 0 }]);
    await q("INSERT INTO conversation (entity_id) VALUES ($1)", [CHAT]);
  });

  it("goes down and up again, keeping the conversations", async () => {
    await ask(["Friday", "Monday"]);
    await down();
    expect(await tables()).toEqual({ t: null, i: null });
    expect((await q("SELECT count(*)::int AS n FROM conversation")).rows).toEqual([{ n: 1 }]);
    await up();
    expect((await q("SELECT count(*)::int AS n FROM question")).rows).toEqual([{ n: 0 }]);
  });
});
