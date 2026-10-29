// Ready replies at the desk (D84, D85): a finished-work card shows the replies Pip offered after
// its own turn, while they're fresh, and desk.reply sends the one you pick through chat.send, as
// the desktop's words (heard), then clears the card. Writing there never lets the desktop read the
// conversation, and nothing goes out once the replies are stale.
import { randomUUID } from "node:crypto";
import { PRINCIPAL } from "@hearth/core";
import { conversationLog, jarvisTurn, notification } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { appendLog, appendNext } from "@hearth/modules";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type DeskApp, deskApp } from "./testing/desk.ts";

let d: DeskApp;
afterEach(() => d.t.destroy());

async function ok<T = Record<string, unknown>>(name: string, input: unknown): Promise<T> {
  const r = await d.t.kernel.execute(name, input, ownerCaller());
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  return r.result as T;
}

/**
 * A turn Pip ran on its own that finished, offered ready replies the real way (appendNext), and
 * left a finished card naming it, as finished.card does.
 */
async function finishedWithReplies(opts: { conversationId?: string; outside?: boolean } = {}) {
  const conversationId =
    opts.conversationId ??
    (await ok<{ conversationId: string }>("chat.send", { text: "Tidy my inbox" })).conversationId;
  const turnId = randomUUID();
  const db = d.t.kernel.db;
  const now = d.t.clock.now();
  await db.insert(jarvisTurn).values({
    id: turnId,
    trigger: "reflex",
    mode: "proactive",
    lane: "fast",
    origin: "system",
    prompt: "Tidy the inbox",
    conversationId,
    status: "done",
    outcome: "act",
    reply: "Archived 12 newsletters.",
  });
  await db.transaction(async (tx) => {
    const marks = [
      { kind: "turn_started" as const, payload: {}, turnId },
      { kind: "turn_finished" as const, payload: {}, turnId },
    ];
    await appendLog(tx, conversationId, marks, now);
    await appendNext(tx, conversationId, turnId, ["Send it", "Make it shorter"], now, opts.outside);
  });
  const cardId = randomUUID();
  await db.insert(notification).values({
    id: cardId,
    kind: "finished",
    title: "Pip finished tidying the inbox",
    body: "Archived 12 newsletters.",
    urgency: "quiet",
    createdBy: PRINCIPAL.jarvis,
    entityId: conversationId,
    dedupeKey: `finished:reflex:${turnId}`,
    createdAt: now,
    updatedAt: now,
  });
  return { conversationId, turnId, cardId };
}

interface Card {
  id: string;
  kind: string;
  outside: boolean;
  replies?: string[];
}
const cards = async () => ((await d.act("desk.list")).body.result as { cards: Card[] }).cards;

const said = async (conversationId: string) =>
  (
    await d.t.kernel.db
      .select()
      .from(conversationLog)
      .where(
        and(
          eq(conversationLog.conversationId, conversationId),
          eq(conversationLog.kind, "user_message"),
        ),
      )
      .orderBy(conversationLog.idx)
  ).map((r) => r.payload);

const stateOf = async (id: string) =>
  (await d.t.kernel.db.select().from(notification).where(eq(notification.id, id)))[0]?.state;

describe("ready replies at the desk", () => {
  it("shows a finished card's replies and sends the one you pick as the desktop's", async () => {
    d = await deskApp();
    const { conversationId, cardId } = await finishedWithReplies();
    await d.unlock();

    expect(await cards()).toEqual([
      expect.objectContaining({ id: cardId, replies: ["Send it", "Make it shorter"] }),
    ]);
    const sent = await d.act("desk.reply", { id: cardId, choice: 1 });
    expect(sent).toEqual({ status: 200, body: { status: "ok", result: { sent: true } } });
    // Through chat.send: the desktop's words, kept as heard, so Pip's turn after runs untrusted.
    const lines = await said(conversationId);
    expect(lines.at(-1)).toMatchObject({ text: "Make it shorter", heard: true });
    expect(await stateOf(cardId)).toBe("done");
    expect(await cards()).toEqual([]);
    // The card is gone, and the reply with it.
    const again = await d.act("desk.reply", { id: cardId, choice: 0 });
    expect([again.status, again.body.code]).toEqual([404, "not_found"]);
    expect(await said(conversationId)).toHaveLength(lines.length);
    // Writing there never let the desktop read the conversation (D42).
    const read = await d.act("conversation.get", { id: conversationId });
    expect(read.status).toBe(404);
  });

  it("sends nothing once the replies are stale, or for another turn's", async () => {
    d = await deskApp();
    const { conversationId, cardId } = await finishedWithReplies();
    // You wrote there since: the replies answered something you've moved past.
    await ok("chat.send", { conversationId, text: "Actually, keep the receipts" });
    // In the same conversation a later card's turn offered some: they're its own, not this card's.
    d.t.clock.advance(1_000);
    const later = await finishedWithReplies({ conversationId, outside: true });
    await d.unlock();

    const listed = await cards();
    expect(listed.map((c) => [c.id, c.replies, c.outside])).toEqual([
      [later.cardId, ["Send it", "Make it shorter"], true],
      [cardId, undefined, false],
    ]);
    const before = (await said(conversationId)).length;
    const stale = await d.act("desk.reply", { id: cardId, choice: 0 });
    expect([stale.status, stale.body.code]).toEqual([409, "conflict"]);
    const past = await d.act("desk.reply", { id: later.cardId, choice: 2 });
    expect([past.status, past.body.code]).toEqual([400, "invalid_input"]);
    expect(await said(conversationId)).toHaveLength(before);
    expect(await stateOf(cardId)).toBe("unseen");
  });

  it("refuses while the desk is closed, and reaches only finished cards", async () => {
    d = await deskApp();
    const { conversationId, cardId } = await finishedWithReplies();
    const closed = await d.act("desk.reply", { id: cardId, choice: 0 });
    expect([closed.status, closed.body.code]).toEqual([403, "forbidden"]);
    const { id: note } = await ok<{ id: string }>("inbox.notify", { title: "Not for the desk" });
    await d.unlock();
    const other = await d.act("desk.reply", { id: note, choice: 0 });
    expect([other.status, other.body.code]).toEqual([404, "not_found"]);
    expect(await said(conversationId)).toHaveLength(1);
    expect(await stateOf(cardId)).toBe("unseen");
  });
});
