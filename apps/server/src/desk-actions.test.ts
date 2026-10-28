// The desk's actions (D84): what the desktop app may do once Windows Hello opened its desk, and
// nothing before. Deciding goes through the kernel's own resolveApproval, never with Always allow;
// a card that waits for a yes or no is done only once it's decided (D58).
import { randomUUID } from "node:crypto";
import { PRINCIPAL } from "@hearth/core";
import { approval, audit, event, notification, question } from "@hearth/db";
import { jarvisCaller, ownerCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type DeskApp, deskApp } from "./testing/desk.ts";

let d: DeskApp;
afterEach(() => d.t.destroy());

async function ok<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  caller = ownerCaller(),
): Promise<T> {
  const r = await d.t.kernel.execute(name, input, caller);
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  return r.result as T;
}

/** Something Pip waits on your yes for: whose an address is, after reading an email. */
async function askFirst(email = "ana@friends.example") {
  const ana = await ok<{ id: string }>("person.create", { name: "Ana" });
  const asked = await d.t.kernel.execute(
    "person.add_email",
    { id: ana.id, email },
    jarvisCaller("untrusted"),
  );
  if (asked.status !== "pending_approval") throw new Error(JSON.stringify(asked));
  const [card] = await d.t.kernel.db
    .select()
    .from(notification)
    .where(eq(notification.approvalId, asked.approvalId));
  return { approvalId: asked.approvalId, cardId: card!.id };
}

/** One of Pip's questions (D85), asked the real way: ask.owner, from one of Pip's turns. */
async function askQuestion(choices = ["The small room", "The big room"]) {
  const { conversationId } = await ok<{ conversationId: string }>("chat.send", { text: "hi" });
  const { questionId } = await ok<{ questionId: string }>(
    "ask.owner",
    { question: "Which room for Friday?", choices },
    jarvisCaller("owner", { turnId: randomUUID(), conversationId }),
  );
  const [card] = await d.t.kernel.db
    .select()
    .from(notification)
    .where(eq(notification.dedupeKey, `question:${questionId}`));
  return { questionId, cardId: card!.id };
}

/**
 * A card for work Pip finished on its own (D85). Only Pip's own code makes these (finished.card,
 * from a finished turn), so the test puts the row in as that leaves it.
 */
async function finishedCard(
  title: string,
  more: Partial<typeof notification.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID();
  const now = d.t.clock.now();
  await d.t.kernel.db.insert(notification).values({
    id,
    kind: "finished",
    title,
    urgency: "quiet",
    createdBy: PRINCIPAL.jarvis,
    createdAt: now,
    updatedAt: now,
    ...more,
  });
  return id;
}

const statusOf = async (id: string) =>
  (await d.t.kernel.db.select().from(approval).where(eq(approval.id, id)))[0]?.status;
const stateOf = async (id: string) =>
  (await d.t.kernel.db.select().from(notification).where(eq(notification.id, id)))[0]?.state;

interface Card {
  id: string;
  kind: string;
  title: string;
  line: string;
  url: string;
  outside: boolean;
  approvalId?: string;
  risk?: string;
  expiresAt?: string | null;
  questionId?: string;
  choices?: string[];
}
const list = async () =>
  (await d.act("desk.list")).body.result as { cards: Card[]; counts: Record<string, number> };

describe("the desk's actions", () => {
  it("refuses every one of them while the desk is closed", async () => {
    d = await deskApp();
    const { approvalId, cardId } = await askFirst();
    const tries: [string, unknown][] = [
      ["desk.list", {}],
      ["desk.decide", { approvalId, decision: "approve" }],
      ["desk.mark", { id: cardId, state: "seen" }],
      ["desk.answer", { questionId: randomUUID(), choice: 0 }],
    ];
    for (const [name, input] of tries) {
      const r = await d.act(name, input);
      expect([name, r.status, r.body.code]).toEqual([name, 403, "forbidden"]);
    }
    expect(await statusOf(approvalId)).toBe("pending");
    expect(await stateOf(cardId)).toBe("unseen");
    // Pip can't reach them at all, desk or not.
    const pip = await d.t.kernel.execute("desk.list", {}, jarvisCaller("owner"));
    expect(pip.status).toBe("denied");
  });

  it("lists the desk's cards newest first, a short line each, with counts", async () => {
    d = await deskApp();
    const { approvalId } = await askFirst();
    d.t.clock.advance(1_000);
    await ok(
      "brief.publish",
      { markdown: "## Today\n- nothing", date: "2026-10-01" },
      jarvisCaller("system"),
    );
    d.t.clock.advance(1_000);
    const email = `${"Dear Ana, ".repeat(40)}\nSecond line\n\n${"More of the email. ".repeat(200)}`;
    // Finished after reading outside content: the card says so.
    await finishedCard(`Pip finished ${"a long job ".repeat(25)}`, { body: email, outside: true });
    await ok("inbox.notify", { title: "Not for the desk" });
    await d.unlock();

    const { cards, counts } = await list();
    // What waits for a yes comes first; the rest newest first.
    expect(cards.map((c) => c.kind)).toEqual(["approval", "finished", "brief"]);
    for (const c of cards) {
      expect(c.title.length).toBeLessThanOrEqual(120);
      expect(c.line.length).toBeLessThanOrEqual(200);
      expect(`${c.title}${c.line}`).not.toContain("\n");
    }
    const [ask, finished, brief] = cards as [Card, Card, Card];
    expect(finished).toMatchObject({ outside: true, url: "/inbox" });
    expect(finished.line.startsWith("Dear Ana,")).toBe(true);
    expect(finished.line).not.toContain("Second line");
    expect(brief).toMatchObject({ outside: false, url: "/today", line: "" });
    expect(ask).toMatchObject({ approvalId, risk: "self_external", outside: true, url: "/today" });
    expect(ask.title).toMatch(/^Pip asks: /);
    expect(ask.expiresAt).toEqual(expect.any(String));
    expect(counts).toEqual({ approval: 1, question: 0, finished: 1, brief: 1, wrap: 0, total: 3 });
  });

  it("decides through the kernel, and never with Always allow", async () => {
    d = await deskApp();
    const first = await askFirst();
    const second = await askFirst("ana@work.example");
    await d.unlock();

    const always = await d.act("desk.decide", {
      approvalId: first.approvalId,
      decision: "approve",
      alwaysAllow: true,
    });
    expect([always.status, always.body.code]).toEqual([400, "invalid_input"]);
    expect(await statusOf(first.approvalId)).toBe("pending");

    const yes = await d.act("desk.decide", { approvalId: first.approvalId, decision: "approve" });
    expect(yes).toEqual({ status: 200, body: { status: "ok", result: { decision: "approved" } } });
    expect(await statusOf(first.approvalId)).toBe("executed");
    expect(await stateOf(first.cardId)).toBe("done");
    const again = await d.act("desk.decide", { approvalId: first.approvalId, decision: "deny" });
    expect([again.status, again.body.code]).toEqual([409, "conflict"]);

    const no = await d.act("desk.decide", { approvalId: second.approvalId, decision: "deny" });
    expect(no.body).toEqual({ status: "ok", result: { decision: "denied" } });
    expect(await statusOf(second.approvalId)).toBe("denied");

    // The audit says the yes came from the desk, and keeps it with the approval.
    const rows = await d.t.kernel.db.select().from(audit).where(eq(audit.action, "desk.decide"));
    const done = rows.filter((r) => r.outcome === "ok");
    expect(done.map((r) => [r.via, r.approvalId])).toEqual([
      ["device", first.approvalId],
      ["device", second.approvalId],
    ]);
    // So does what announces it, for the yes and the no alike.
    const resolved = await d.t.kernel.db
      .select()
      .from(event)
      .where(eq(event.kind, "approval.resolved"));
    expect(resolved.map((e) => [e.payload.approvalId, e.payload.desk])).toEqual([
      [first.approvalId, true],
      [second.approvalId, true],
    ]);
    // Looking at the desk is a read: no audit row each time.
    await d.act("desk.list");
    const looks = await d.t.kernel.db.select().from(audit).where(eq(audit.action, "desk.list"));
    expect(looks).toEqual([]);
  });

  it("marks cards seen or done, but a card that waits for a yes or an answer only seen", async () => {
    d = await deskApp();
    const { cardId } = await askFirst();
    const asked = await askQuestion();
    const finished = await finishedCard("Pip finished tidying the inbox");
    const { id: note } = await ok<{ id: string }>("inbox.notify", { title: "Not for the desk" });
    await d.unlock();

    const done = await d.act("desk.mark", { id: cardId, state: "done" });
    expect([done.status, done.body.code]).toEqual([409, "conflict"]);
    expect(await stateOf(cardId)).toBe("unseen");
    expect((await d.act("desk.mark", { id: cardId, state: "seen" })).body).toMatchObject({
      result: { updated: 1 },
    });
    expect(await stateOf(cardId)).toBe("seen");

    const open = await d.act("desk.mark", { id: asked.cardId, state: "done" });
    expect([open.status, open.body.code]).toEqual([409, "conflict"]);
    expect(await stateOf(asked.cardId)).toBe("unseen");

    expect((await d.act("desk.mark", { id: finished, state: "done" })).status).toBe(200);
    expect((await list()).cards.map((c) => c.kind)).toEqual(["approval", "question"]);
    // Seen never takes a card that's done back out.
    const seen = await d.act("desk.mark", { id: finished, state: "seen" });
    expect(seen.body).toMatchObject({ result: { updated: 0 } });
    expect(await stateOf(finished)).toBe("done");
    // The rest of the inbox stays out of the desk's reach.
    expect((await d.act("desk.mark", { id: note, state: "done" })).status).toBe(404);
    expect(await stateOf(note)).toBe("unseen");
  });

  it("answers Pip's questions with one of their choices", async () => {
    d = await deskApp();
    const { questionId, cardId } = await askQuestion();
    await d.unlock();

    const [card] = (await list()).cards;
    expect(card).toMatchObject({
      id: cardId,
      kind: "question",
      questionId,
      choices: ["The small room", "The big room"],
      outside: false,
    });
    const answered = await d.act("desk.answer", { questionId, choice: 1 });
    expect(answered.body).toEqual({ status: "ok", result: { answered: true } });
    const [q] = await d.t.kernel.db.select().from(question).where(eq(question.id, questionId));
    expect(q).toMatchObject({ status: "answered", answer: { choice: 1 } });
    expect(await stateOf(cardId)).toBe("done");
    const twice = await d.act("desk.answer", { questionId, text: "Either" });
    expect([twice.status, twice.body.code]).toEqual([409, "conflict"]);
  });

  it("keeps what waits for you in view, however much finished work piles up", async () => {
    d = await deskApp();
    const { approvalId } = await askFirst();
    d.t.clock.advance(1_000);
    const { questionId } = await askQuestion();
    for (let i = 0; i < 40; i++) {
      d.t.clock.advance(1_000);
      await finishedCard(`Pip finished job ${i}`);
    }
    await d.unlock();
    const { cards, counts } = await list();
    expect(cards).toHaveLength(30);
    expect(cards.slice(0, 2)).toMatchObject([{ approvalId }, { questionId }]);
    // The rest newest first.
    expect(cards[2]?.title).toBe("Pip finished job 39");
    expect(counts).toMatchObject({ approval: 1, question: 1, finished: 40, total: 42 });
  });
});
