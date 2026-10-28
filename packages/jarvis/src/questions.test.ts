// Pip asks with choices (D85): ask_owner leaves a question with numbered choices and a card in
// the inbox, and the turn ends there. Your answer, given in Nook or at the desk, records it, puts
// the card away and starts Pip again in the same conversation, as trusted as the asking turn and
// in the same job (questions-trust.test.ts has the rest of who may answer and how much). A second
// answer, two at once, or one after the question lapsed is refused as a conflict, with a plain
// reason.
import { jarvisTurn, notification, question, schedule } from "@hearth/db";
import { newId, ownerCaller } from "@hearth/kernel";
import { asc, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScriptStep } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;
const DAY = 24 * 60 * 60_000;

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thu 10 a.m. ET
  // Only the questions' own checks fire as days pass: not the brief, the heartbeat or the rest.
  await h.tdb.db.delete(schedule).where(like(schedule.id, "routine:%"));
});
afterEach(() => h.destroy());

const ASK: ScriptStep = {
  call: "ask_owner",
  input: { question: "Which day works for the dentist?", choices: ["Friday", "Monday"] },
};
const questions = () => h.tdb.db.select().from(question).orderBy(asc(question.createdAt));
const cards = () => h.tdb.db.select().from(notification).where(eq(notification.kind, "question"));
const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
const answer = (id: string, a: { choice?: number; text?: string }) =>
  h.kernel.execute<{ ok: boolean; reason?: string }>(
    "question.answer",
    { id, ...a },
    ownerCaller(),
  );

/** You ask Pip something in chat, and it asks you back with choices. */
async function chatThatAsks(steps: ScriptStep[] = [ASK]) {
  h.brain.next([...steps, { say: "I asked which day suits you." }]);
  const sent = await h.kernel.execute<{ conversationId: string }>(
    "chat.send",
    { text: "book me a dentist appointment" },
    ownerCaller(),
  );
  if (sent.status !== "ok") throw new Error(JSON.stringify(sent));
  await h.settle();
  const [q] = await questions();
  return { conversationId: sent.result.conversationId, q: q! };
}

describe("Pip asks you with choices", () => {
  it("leaves a question and its card, and the turn ends waiting", async () => {
    const { conversationId, q } = await chatThatAsks();
    expect(q).toMatchObject({
      conversationId,
      question: "Which day works for the dentist?",
      choices: ["Friday", "Monday"],
      status: "open",
      origin: "owner",
      answer: null,
    });
    expect(q.expiresAt.getTime() - q.createdAt.getTime()).toBe(3 * DAY);
    expect(await cards()).toMatchObject([
      {
        title: "Which day works for the dentist?",
        body: "1. Friday · 2. Monday",
        entityId: conversationId,
        dedupeKey: `question:${q.id}`,
        state: "unseen",
        outside: false,
      },
    ]);
    const [turn] = await turns();
    // Asking is "ask", not "act": it changed nothing for you yet.
    expect(turn).toMatchObject({ status: "done", outcome: "ask", id: q.turnId });
    // The model is told to stop there and wait.
    const said = h.brain.requests[0]!.tools.find((t) => t.name === "ask_owner");
    expect(said?.description).toContain("end your turn right after");
  });

  it("starts Pip again in the same conversation with what you chose, once", async () => {
    const { conversationId, q } = await chatThatAsks();
    expect((await answer(q.id, { choice: 1 })).status).toBe("ok");
    const [after] = await questions();
    expect(after).toMatchObject({ status: "answered", answer: { choice: 1 } });
    expect(after!.answeredAt).toEqual(h.clock.now());
    expect((await cards())[0]!.state).toBe("done");

    h.brain.next([{ say: "Booked for Monday." }]);
    await h.settle();
    const resumed = (await turns()).at(-1)!;
    expect(resumed).toMatchObject({
      trigger: "approval",
      conversationId,
      origin: "owner",
      dedupeKey: `question:${q.id}`,
      status: "done",
    });
    expect(resumed.prompt).toContain('they chose "Monday"');
    expect(resumed.prompt).toContain("Which day works for the dentist?");

    // A second answer changes nothing and starts nothing.
    const again = await answer(q.id, { choice: 0, text: "Friday after all" });
    expect(again).toEqual({
      status: "error",
      code: "conflict",
      message: "That question was already answered.",
    });
    await h.settle();
    expect(await turns()).toHaveLength(2);
    expect((await questions())[0]!.answer).toEqual({ choice: 1 });
  });

  it("takes your own words, and refuses a choice it doesn't have", async () => {
    const { q } = await chatThatAsks();
    expect(await answer(q.id, { choice: 2 })).toMatchObject({
      code: "conflict",
      message: "Pick a choice from 1 to 2.",
    });
    expect((await answer(q.id, { choice: 3 })).status).toBe("error");
    const r = await h.kernel.execute("question.answer", { id: q.id, text: "  " }, ownerCaller());
    expect(r).toMatchObject({ status: "error", code: "conflict" });
    await answer(q.id, { text: "Neither, next week" });
    h.brain.next([{ say: "OK, next week then." }]);
    await h.settle();
    expect((await turns()).at(-1)!.prompt).toContain("in their own words: Neither, next week");
  });

  it("lets a question lapse after three days: its card goes and an answer is refused", async () => {
    const { q } = await chatThatAsks();
    h.clock.advance(3 * DAY + 60_000);
    await h.settle();
    expect((await questions())[0]!.status).toBe("expired");
    expect((await cards())[0]!.state).toBe("done");
    expect(await answer(q.id, { choice: 0 })).toMatchObject({
      code: "conflict",
      message: "That question lapsed, so Pip stopped waiting for an answer.",
    });
    expect(await turns()).toHaveLength(1);
  });

  it("refuses an answer past its time even before the sweep put it away", async () => {
    const { q } = await chatThatAsks();
    h.clock.advance(3 * DAY + 60_000);
    expect(await answer(q.id, { choice: 0 })).toMatchObject({
      code: "conflict",
      message: "That question lapsed, so Pip stopped waiting for an answer.",
    });
    await h.settle();
    expect((await questions())[0]!.status).toBe("expired");
    expect(await turns()).toHaveLength(1);
  });

  it("lets only one of two answers at once through", async () => {
    const { q } = await chatThatAsks();
    const both = await Promise.all([answer(q.id, { choice: 0 }), answer(q.id, { choice: 1 })]);
    expect(both.map((r) => r.status).sort()).toEqual(["error", "ok"]);
    expect(both.find((r) => r.status === "error")).toMatchObject({
      code: "conflict",
      message: "That question was already answered.",
    });
    h.brain.otherwise([{ say: "Booked." }]);
    await h.settle();
    expect((await turns()).filter((t) => t.trigger === "approval")).toHaveLength(1);
  });

  it("asks once a turn, with choices that differ", async () => {
    const dup: ScriptStep = {
      call: "ask_owner",
      input: { question: "Which?", choices: ["A", "a"] },
    };
    await chatThatAsks([dup, ASK, ASK]);
    expect(await questions()).toHaveLength(1);
    expect(await cards()).toHaveLength(1);
  });

  it("marks a question asked after reading outside content, and its work stays that untrusted", async () => {
    const { q } = await chatThatAsks([
      { readWeb: "WebFetch", text: "Dentist hours: Fri, Mon" },
      ASK,
    ]);
    expect(q.origin).toBe("untrusted");
    expect((await cards())[0]!.outside).toBe(true);
    await answer(q.id, { choice: 0 });
    h.brain.next([{ say: "Booked." }]);
    await h.settle();
    const resumed = (await turns()).at(-1)!;
    expect(resumed.origin).toBe("untrusted");
    // Its own words are quoted as outside content's.
    expect(resumed.prompt).toContain('<untrusted source="ask_owner">');
  });

  it("keeps background work background work when it picks up again", async () => {
    h.brain.next([ASK, { say: "Asked." }]);
    const now = h.clock.now();
    await h.tdb.db.insert(jarvisTurn).values({
      id: newId(),
      trigger: "reflex",
      mode: "proactive",
      lane: "deep",
      origin: "system",
      prompt: "Book the dentist.",
      queuedAt: now,
      notBefore: now,
    });
    await h.settle();
    const [q] = await questions();
    expect(q!.origin).toBe("system");
    await answer(q!.id, { choice: 0 });
    h.brain.next([{ say: "Booked." }]);
    await h.settle();
    expect((await turns()).at(-1)).toMatchObject({
      trigger: "approval",
      mode: "proactive",
      lane: "deep",
      origin: "system",
    });
  });

  it("picks the work up again in the asking turn's job", async () => {
    const job = await h.kernel.execute<{ id: string }>(
      "role.create",
      { name: "Errands", riskCeiling: "internal" },
      ownerCaller(),
    );
    if (job.status !== "ok") throw new Error(JSON.stringify(job));
    h.brain.next([ASK, { say: "Asked." }]);
    const now = h.clock.now();
    await h.tdb.db.insert(jarvisTurn).values({
      id: newId(),
      trigger: "reflex",
      mode: "proactive",
      lane: "fast",
      origin: "system",
      roleId: job.result.id,
      prompt: "Book the dentist.",
      queuedAt: now,
      notBefore: now,
    });
    await h.settle();
    const [q] = await questions();
    await answer(q!.id, { choice: 1 });
    h.brain.next([{ say: "Booked." }]);
    await h.settle();
    expect((await turns()).at(-1)).toMatchObject({
      trigger: "approval",
      roleId: job.result.id,
      status: "done",
    });
  });
});
