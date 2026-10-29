// Your conversations at the desk (D86): with Windows Hello's desk open, the desktop's notch reads
// any of your conversations, a page of lines at a time, with what Pip is doing there and the
// replies it offers. Without the desk it reads none but its own, and a Slack member's never.
import { randomUUID } from "node:crypto";
import { MEMBER_CONVERSATION } from "@hearth/core";
import { conversation, entity, jarvisTurn } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { appendLog, appendNext } from "@hearth/modules";
import { afterEach, describe, expect, it } from "vitest";
import { type DeskApp, deskApp } from "./testing/desk.ts";

let d: DeskApp;
afterEach(() => d.t.destroy());

async function ok<T = Record<string, unknown>>(name: string, input: unknown): Promise<T> {
  const r = await d.t.kernel.execute(name, input, ownerCaller());
  if (r.status !== "ok") throw new Error(JSON.stringify(r));
  return r.result as T;
}

/** A conversation you started in Nook's window, so the app's token alone can't read it. */
const fromNook = async (text: string) =>
  (await ok<{ conversationId: string }>("chat.send", { text })).conversationId;

interface Line {
  idx: number;
  kind: string;
  payload: { text?: string };
}
interface Lines {
  conversation: { id: string; title: string; startedVia: string | null };
  log: Line[];
  more: boolean;
  pip: { state: string; label: string | null };
  next: { replies: string[]; outside: boolean };
}
interface Listed {
  conversations: { id: string; title: string; working: boolean; mine: boolean }[];
}

const read = async (input: Record<string, unknown>) => {
  const r = await d.act("desk.conversation", input);
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  return r.body.result as Lines;
};

/** Pip's answer in a turn that started and finished, logged as the runtime logs one. */
async function answered(conversationId: string, text: string) {
  const turnId = randomUUID();
  await d.t.kernel.db.transaction((tx) =>
    appendLog(
      tx,
      conversationId,
      [
        { kind: "turn_started", payload: {}, turnId },
        { kind: "tool_call", payload: { name: "calendar.list", callId: "a" }, turnId },
        { kind: "assistant_message", payload: { text }, turnId },
        { kind: "turn_finished", payload: {}, turnId },
      ],
      d.t.clock.now(),
    ),
  );
  return turnId;
}

describe("conversations at the desk", () => {
  it("reads any of your conversations once the desk is open, and none of them before", async () => {
    d = await deskApp();
    const yours = await fromNook("When's the dentist?");
    const turnId = await answered(yours, "Thursday at 3.");
    await d.t.kernel.db.transaction((tx) =>
      appendNext(tx, yours, turnId, ["Move it to Friday", "Thanks"], d.t.clock.now()),
    );

    // The token alone: the desk's refusal, and conversation.get's as ever (D42).
    const shut = await d.act("desk.conversation", { id: yours });
    expect([shut.status, shut.body.code]).toEqual([403, "forbidden"]);
    expect((await d.act("desk.conversation", {})).status).toBe(403);
    expect((await d.act("conversation.get", { id: yours })).status).toBe(404);

    await d.unlock();
    const listed = (await d.act("desk.conversation", {})).body.result as Listed;
    expect(listed.conversations).toEqual([
      expect.objectContaining({ id: yours, title: "When's the dentist?", working: false }),
    ]);
    const got = await read({ id: yours });
    expect(got.conversation).toMatchObject({ id: yours, startedVia: null });
    // Lines only: your words and Pip's, not its working.
    expect(got.log.map((l) => [l.kind, l.payload.text])).toEqual([
      ["user_message", "When's the dentist?"],
      ["assistant_message", "Thursday at 3."],
    ]);
    expect(got.more).toBe(false);
    expect(got.pip).toEqual({ state: "idle", label: null });
    expect(got.next).toEqual({ replies: ["Move it to Friday", "Thanks"], outside: false });
    // Reading at the desk still never opens conversation.get to the token.
    expect((await d.act("conversation.get", { id: yours })).status).toBe(404);
  });

  it("writes there at the desk through chat.send itself, kept as the desktop's words", async () => {
    d = await deskApp();
    const yours = await fromNook("Plan the week");
    const send = { conversationId: yours, text: "And Friday?" };
    // The token alone may not write in a conversation it didn't start (D42).
    expect((await d.act("chat.send", send)).status).toBe(404);

    await d.unlock();
    const sent = await d.act("chat.send", send);
    expect(sent.status).toBe(200);
    const { idx } = sent.body.result as { idx: number };
    const got = await read({ id: yours });
    // Heard, as anything that device sends is (D58): the nightly memory never takes it for yours.
    expect(got.log.at(-1)).toMatchObject({
      idx,
      kind: "user_message",
      payload: { text: "And Friday?", heard: true },
    });
    expect(got.log[0]?.payload).not.toHaveProperty("heard");
  });

  it("says when Pip is on it, and what about", async () => {
    d = await deskApp();
    const yours = await fromNook("Plan my week");
    await d.t.kernel.db.insert(jarvisTurn).values({
      id: randomUUID(),
      trigger: "chat",
      mode: "reactive",
      lane: "deep",
      origin: "owner",
      prompt: "Plan my week",
      conversationId: yours,
      status: "running",
    });
    await d.unlock();
    const listed = (await d.act("desk.conversation", {})).body.result as Listed;
    expect(listed.conversations[0]).toMatchObject({ id: yours, working: true, mine: false });
    expect((await read({ id: yours })).pip).toEqual({ state: "thinking", label: "what you asked" });
  });

  it("refuses a Slack member's conversation, and leaves it out of the list", async () => {
    d = await deskApp();
    const member = randomUUID();
    await d.t.kernel.db.insert(entity).values({
      id: member,
      type: "conversation",
      title: "Slack: Sam Lee",
      createdBy: "system",
      updatedBy: "system",
    });
    await d.t.kernel.db
      .insert(conversation)
      .values({ entityId: member, startedVia: MEMBER_CONVERSATION });
    const yours = await fromNook("Hello");
    await d.unlock();

    const refused = await d.act("desk.conversation", { id: member });
    expect([refused.status, refused.body.code]).toEqual([404, "not_found"]);
    const listed = (await d.act("desk.conversation", {})).body.result as Listed;
    expect(listed.conversations.map((c) => c.id)).toEqual([yours]);
    const nowhere = await d.act("desk.conversation", { id: randomUUID() });
    expect(nowhere.status).toBe(404);
  });

  it("pages back 50 lines at a time, and forward from a line", async () => {
    d = await deskApp();
    const yours = await fromNook("Line 0");
    await d.t.kernel.db.transaction((tx) =>
      appendLog(
        tx,
        yours,
        Array.from({ length: 119 }, (_, n) => ({
          kind: n % 2 ? ("user_message" as const) : ("assistant_message" as const),
          payload: { text: `Line ${n + 1}` },
        })),
        d.t.clock.now(),
      ),
    );
    await d.unlock();

    const texts = (p: Lines) => p.log.map((l) => l.payload.text);
    const newest = await read({ id: yours });
    expect([newest.log.length, newest.more]).toEqual([50, true]);
    expect([texts(newest)[0], texts(newest).at(-1)]).toEqual(["Line 70", "Line 119"]);
    const back = await read({ id: yours, before: newest.log[0]!.idx });
    expect([back.log.length, back.more, texts(back)[0]]).toEqual([50, true, "Line 20"]);
    const last = await read({ id: yours, before: back.log[0]!.idx });
    expect([last.log.length, last.more, texts(last)[0]]).toEqual([20, false, "Line 0"]);

    // What came after a line, oldest first: what the notch asks for while Pip works.
    const since = await read({ id: yours, after: newest.log.at(-3)!.idx });
    expect([texts(since), since.more]).toEqual([["Line 118", "Line 119"], false]);
    const few = await read({ id: yours, after: back.log.at(-1)!.idx, limit: 2 });
    expect([texts(few), few.more]).toEqual([["Line 70", "Line 71"], true]);

    const both = await d.act("desk.conversation", { id: yours, before: 10, after: 2 });
    expect([both.status, both.body.code]).toEqual([400, "invalid_input"]);
    const big = await d.act("desk.conversation", { id: yours, limit: 51 });
    expect(big.status).toBe(400);
  });
});
