// Eval scenarios for the jobs D82 moved to a cheaper model: a spoken rewrite, a watch firing and
// sorting a Slack ask at the heartbeat on Haiku; the evening journal and a long ask in chat on
// Sonnet, both once Opus. Like the others, each checks the outcome in the database, not the wording.
import { randomBytes } from "node:crypto";
import { entity, task } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { FakeSlack, SLACK_SERVICE, VAULT_SERVICE, Vault } from "@hearth/modules";
import { eq } from "drizzle-orm";
import type { JarvisHarness } from "../testing.ts";
import type { Scenario } from "./scenarios.ts";

async function ok<T = { id: string }>(
  h: JarvisHarness,
  name: string,
  input: unknown,
  caller: Caller = ownerCaller(),
): Promise<T> {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

const fail = (cond: boolean, msg: string) => (cond ? [] : [msg]);

async function taskTitles(h: JarvisHarness): Promise<string[]> {
  const rows = await h.tdb.db
    .select({ title: entity.title })
    .from(task)
    .innerJoin(entity, eq(entity.id, task.entityId));
  return rows.map((r) => r.title);
}

/** The voice command made in `act`, to read its answer in `check`. */
let voiceId = "";

export const TIER_SCENARIOS: Scenario[] = [
  {
    name: "voice",
    description: "A spoken 'make this more formal' rewrites the selection and nothing else.",
    start: "2026-10-01T14:00:00Z",
    async setup() {},
    async act(h) {
      const r = await ok(h, "voice.command", {
        instruction: "make this more formal",
        selection: "hey can we push our call to friday, something came up",
        app: "Slack.exe",
      });
      voiceId = r.id;
      await h.settle();
    },
    async check(h) {
      const r = await ok<{ status: string; text?: string }>(h, "voice.command_result", {
        id: voiceId,
      });
      const text = r.text ?? "";
      return [
        ...fail(r.status === "done" && text.length > 0, `no rewrite (${r.status})`),
        ...fail(/friday/i.test(text), "the rewrite lost Friday"),
        ...fail(!/^(sure|here|certainly)\b|```|^"/i.test(text.trim()), "it added a preamble"),
        ...fail(!/\bhey\b/i.test(text), "it isn't more formal"),
      ];
    },
  },
  {
    name: "watch",
    description: "A watch on a task fires when it's done, and Pip does what the watch said.",
    start: "2026-10-01T14:00:00Z",
    async setup(h) {
      const t = await ok(h, "task.create", { title: "Send the contract to Acme" });
      await ok(h, "jarvis.watch", {
        description:
          "When the task 'Send the contract to Acme' is completed, make a task to invoice Acme, due in a week.",
        filter: {
          and: [
            { field: "kind", op: "eq", value: "task.status_changed" },
            { field: "entityId", op: "eq", value: t.id },
          ],
        },
        subjectId: t.id,
      });
    },
    async act(h) {
      const [t] = await h.tdb.db
        .select({ id: entity.id })
        .from(entity)
        .where(eq(entity.title, "Send the contract to Acme"));
      await ok(h, "task.update", { id: t!.id, status: "completed" });
      await h.settle();
    },
    async check(h) {
      const titles = await taskTitles(h);
      return fail(
        titles.some((t) => /invoice/i.test(t) && /acme/i.test(t)),
        `no task to invoice Acme (tasks: ${titles.join("; ")})`,
      );
    },
  },
  {
    name: "slack",
    description:
      "At the heartbeat, a Slack ask becomes a task and a thank-you becomes nothing (Haiku).",
    start: "2026-10-01T14:00:00Z",
    async setup(h) {
      const s = new FakeSlack();
      s.clock = Math.floor(h.clock.now().getTime() / 1000) - 3600;
      s.conversations = [
        { id: "D1", name: "", kind: "dm", user: "UEVE" },
        { id: "D2", name: "", kind: "dm", user: "USAM" },
      ];
      s.users.set("UEVE", { id: "UEVE", name: "Eve", bot: false });
      s.users.set("USAM", { id: "USAM", name: "Sam", bot: false });
      h.kernel.services[SLACK_SERVICE] = s.api();
      h.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
      await ok(h, "slack.connect", { token: s.token });
      s.post("D1", "UEVE", "Welcome aboard!");
      await ok(h, "slack.sync", {}, integrationCaller("slack"));
      await h.settle();
      s.post("D1", "UEVE", "Can you send me the Q3 deck by Friday?");
      s.post("D2", "USAM", "thanks for yesterday, it was great!");
      await ok(h, "slack.sync", {}, integrationCaller("slack"));
      await h.settle();
    },
    async act(h) {
      h.clock.set("2026-10-01T14:25:30Z"); // 10:25: the heartbeat
      await h.settle();
    },
    async check(h) {
      const titles = await taskTitles(h);
      return [
        ...fail(
          titles.some((t) => /deck/i.test(t)),
          `no task for Eve's deck (${titles.join("; ")})`,
        ),
        ...fail(titles.length === 1, `${titles.length} tasks, expected just the deck`),
      ];
    },
  },
  {
    name: "journal",
    description: "The 7:30 p.m. journal records what got done today, which its facts leave out.",
    start: "2026-10-01T14:00:00Z",
    async setup(h) {
      const t = await ok(h, "task.create", { title: "Renew the car insurance" });
      await ok(h, "task.update", { id: t.id, status: "completed" });
      await ok(h, "task.create", { title: "Book flights to Denver" });
    },
    async act(h) {
      h.clock.set("2026-10-01T23:30:10Z"); // Thursday 7:30 p.m.
      await h.settle();
    },
    async check(h) {
      const [j] = await h.tdb.db.select().from(entity).where(eq(entity.type, "journal"));
      return [
        ...fail(Boolean(j), "no journal entry"),
        ...fail(/insurance/i.test(j?.body ?? ""), "the journal leaves out what got done"),
      ];
    },
  },
  {
    name: "plan",
    description: "A long ask in chat (the deep lane, now Sonnet) becomes one task per item.",
    start: "2026-10-01T14:00:00Z",
    async setup() {},
    async act(h) {
      await ok(h, "chat.send", {
        text: "plan my week: I need to finish the budget, call the bank, and book flights to Denver. make a task for each.",
      });
      await h.settle();
    },
    async check(h) {
      const titles = await taskTitles(h);
      const has = (re: RegExp) => titles.some((t) => re.test(t));
      return [
        ...fail(has(/budget/i), "no task for the budget"),
        ...fail(has(/bank/i), "no task for the bank"),
        ...fail(has(/flight|denver/i), "no task for the flights"),
      ];
    },
  },
];
