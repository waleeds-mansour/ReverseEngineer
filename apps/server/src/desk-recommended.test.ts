// The choice Pip recommends on one of its questions (D85): ask.owner takes it by its place in the
// choices and refuses a place the question doesn't have, and the question's card on the desk
// carries it so the Inbox can mark that choice Recommended. Most questions carry none.
import { randomUUID } from "node:crypto";
import { question } from "@hearth/db";
import { jarvisCaller, ownerCaller } from "@hearth/kernel";
import { asc } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { type DeskApp, deskApp } from "./testing/desk.ts";

let d: DeskApp;
afterEach(() => d.t.destroy());

/** Pip asks, from one of its turns in a conversation of yours, as ask_owner does. */
async function ask(more: Record<string, unknown> = {}) {
  const chat = await d.t.kernel.execute("chat.send", { text: "hi" }, ownerCaller());
  if (chat.status !== "ok") throw new Error(JSON.stringify(chat));
  const { conversationId } = chat.result as { conversationId: string };
  return d.t.kernel.execute(
    "ask.owner",
    { question: "Which room for Friday?", choices: ["The small room", "The big room"], ...more },
    jarvisCaller("owner", { turnId: randomUUID(), conversationId }),
  );
}

interface Card {
  kind: string;
  questionId?: string;
  choices?: string[];
  recommended?: number;
}

describe("the choice Pip recommends", () => {
  it("is refused when it names no choice the question has", async () => {
    d = await deskApp();
    expect(await ask({ recommended: 2 })).toEqual({
      status: "error",
      code: "invalid_input",
      message: "Recommend one of your 2 choices by its place, from 0 to 1.",
    });
    expect(await ask({ recommended: 3 })).toMatchObject({ status: "error", code: "invalid_input" });
    expect(await ask({ recommended: -1 })).toMatchObject({
      status: "error",
      code: "invalid_input",
    });
    // Nothing was asked, so nothing waits in the inbox.
    expect(await d.t.kernel.db.select().from(question)).toEqual([]);
  });

  it("rides on the question's card, and a question without one carries none", async () => {
    d = await deskApp();
    const plain = await ask();
    d.t.clock.advance(1_000);
    const picked = await ask({ recommended: 1, why: "It fits all eight of you." });
    if (plain.status !== "ok" || picked.status !== "ok") throw new Error("ask.owner failed");
    const stored = await d.t.kernel.db
      .select({ r: question.recommended })
      .from(question)
      .orderBy(asc(question.createdAt));
    expect(stored).toEqual([{ r: null }, { r: 1 }]);

    await d.unlock();
    const listed = await d.act("desk.list");
    const cards = (listed.body.result as { cards: Card[] }).cards;
    const { questionId: pickedId } = picked.result as { questionId: string };
    const { questionId: plainId } = plain.result as { questionId: string };
    expect(cards.find((c) => c.questionId === pickedId)).toMatchObject({
      kind: "question",
      choices: ["The small room", "The big room"],
      recommended: 1,
    });
    expect(cards.find((c) => c.questionId === plainId)).not.toHaveProperty("recommended");
  });
});
