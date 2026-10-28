// Ready replies (D85): after Pip answers in a conversation you're in, up to two short replies you
// might send next are kept as a `next` entry in its log, made after the turn ended by a single
// cheap step (a fake here: never a real model in tests), whose tokens go in the turn log. Not for
// an answer that closes the topic, a failed turn, Pip's own work or a turn that asked you
// something; stale once you write again, even while the turn ran; only ever offered.

import { foldConversation, type LogRecord } from "@hearth/core";
import { conversationLog, jarvisTurn } from "@hearth/db";
import { newId, ownerCaller } from "@hearth/kernel";
import { readyRepliesFor } from "@hearth/modules";
import { and, asc, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { ScriptedBrain } from "./brains/scripted.ts";
import { modelForJob } from "./models.ts";
import { brainReplies, closesTopic, type NextReplies, tidyReplies } from "./next.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";
import type { TurnLogLine } from "./turn-log.ts";

let h: JarvisHarness;

const DRAFT =
  "Here's a draft reply to Ana, saying you can meet Thursday at 3 and asking for the address.";

const HAIKU = { "claude-haiku": { input: 120, output: 9, cacheRead: 0, cacheWrite: 0 } };

/** A fake model: what it was asked, and what it says back. */
function fake(lines: string[] | (() => Promise<string[]>)) {
  const asked: { asked: string; reply: string }[] = [];
  const suggest: NextReplies = async ({ asked: a, reply }) => {
    asked.push({ asked: a, reply });
    return { lines: typeof lines === "function" ? await lines() : lines, usage: HAIKU };
  };
  return { asked, suggest };
}

let logged: TurnLogLine[] = [];

async function start(suggest: NextReplies) {
  logged = [];
  h = await createJarvisHarness("2026-10-01T14:00:00Z", {
    runner: { nextReplies: suggest, turnLog: (l) => logged.push(l) },
  });
}

async function chat(text: string, reply: string, conversationId?: string) {
  h.brain.next([{ say: reply }]);
  const sent = await h.kernel.execute<{ conversationId: string }>(
    "chat.send",
    { text, ...(conversationId ? { conversationId } : {}) },
    ownerCaller(),
  );
  if (sent.status !== "ok") throw new Error(JSON.stringify(sent));
  await h.settle();
  return sent.result.conversationId;
}

const nextEntries = (cid: string) =>
  h.tdb.db
    .select()
    .from(conversationLog)
    .where(and(eq(conversationLog.conversationId, cid), eq(conversationLog.kind, "next")))
    .orderBy(asc(conversationLog.idx));

const shown = async (cid: string) => {
  const res = await h.kernel.execute<{ log: LogRecord[] }>(
    "conversation.get",
    { id: cid },
    ownerCaller(),
  );
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return foldConversation(res.result.log).next;
};

describe("ready replies", () => {
  afterEach(() => h.destroy());

  it("are offered after Pip answers you, and go stale once you write", async () => {
    const f = fake(["1. Send it", '"Make it shorter"', "Add it to my calendar"]);
    await start(f.suggest);
    const cid = await chat("draft a reply to Ana", DRAFT);
    expect(f.asked).toEqual([{ asked: "draft a reply to Ana", reply: DRAFT }]);
    const [entry] = await nextEntries(cid);
    expect(entry).toMatchObject({ payload: { replies: ["Send it", "Make it shorter"] } });
    const [turn] = await h.tdb.db.select().from(jarvisTurn);
    expect(entry!.turnId).toBe(turn!.id);
    // conversation.get returns them in the log, and the fold shows them.
    const offered = { replies: ["Send it", "Make it shorter"], outside: false };
    expect(await shown(cid)).toEqual(offered);
    // It says which to offer too, from the whole log, even when only newer lines are asked for.
    const got = await h.kernel.execute(
      "conversation.get",
      { id: cid, afterIdx: entry!.idx },
      ownerCaller(),
    );
    expect(got).toMatchObject({ result: { log: [], next: offered } });
    expect(await readyRepliesFor(h.tdb.db, cid)).toEqual(offered);
    // Its tokens are counted in the turn log, as the next job's (D82).
    expect(logged.filter((l) => l.job === "next")).toMatchObject([
      { turnId: turn!.id, trigger: "chat", status: "done", tools: 0, usage: HAIKU },
    ]);

    // You write: they're stale at once, and the short closing answer brings none.
    const sent = await h.kernel.execute(
      "chat.send",
      { conversationId: cid, text: "Send it" },
      ownerCaller(),
    );
    expect(sent.status).toBe("ok");
    const none = { replies: [], outside: false };
    expect(await readyRepliesFor(h.tdb.db, cid)).toEqual(none);
    expect(await h.kernel.execute("conversation.get", { id: cid }, ownerCaller())).toMatchObject({
      result: { next: none },
    });
    h.brain.next([{ say: "Sent." }]);
    await h.settle();
    expect(f.asked).toHaveLength(1);
    expect(await shown(cid)).toEqual(none);
  });

  it("aren't offered for Pip's own work, nor when the model has none or fails", async () => {
    let fail = false;
    const f = fake(async () => {
      if (fail) throw new Error("model down");
      return ["NONE"];
    });
    await start(f.suggest);
    const cid = await chat("what's on today?", DRAFT);
    expect(await nextEntries(cid)).toEqual([]);
    fail = true;
    await chat("and tomorrow?", DRAFT, cid);
    expect(await nextEntries(cid)).toEqual([]);
    expect(h.logs.some((l) => l.includes("couldn't offer ready replies"))).toBe(true);

    // A turn of Pip's own, in its own conversation: nobody there to reply.
    h.brain.next([{ say: DRAFT }]);
    const now = h.clock.now();
    await h.tdb.db.insert(jarvisTurn).values({
      id: newId(),
      trigger: "reflex",
      mode: "proactive",
      lane: "fast",
      origin: "system",
      prompt: "Look at what came in.",
      queuedAt: now,
      notBefore: now,
    });
    await h.settle();
    expect(f.asked).toHaveLength(2);
  });

  it("are left out when you wrote again while they were being made", async () => {
    let cid = "";
    const f = fake(async () => {
      await h.kernel.execute("chat.send", { conversationId: cid, text: "wait" }, ownerCaller());
      return ["Send it"];
    });
    await start(f.suggest);
    h.brain.next([{ say: DRAFT }]);
    const sent = await h.kernel.execute<{ conversationId: string }>(
      "chat.send",
      { text: "draft a reply to Ana" },
      ownerCaller(),
    );
    if (sent.status !== "ok") throw new Error(JSON.stringify(sent));
    cid = sent.result.conversationId;
    h.brain.otherwise([{ say: "OK." }]);
    await h.settle();
    expect(await nextEntries(cid)).toEqual([]);
  });

  it("say so when the answer read outside content", async () => {
    await start(fake(["Send it"]).suggest);
    h.brain.next([{ readWeb: "WebFetch", text: "a page" }, { say: DRAFT }]);
    const sent = await h.kernel.execute<{ conversationId: string }>(
      "chat.send",
      { text: "look this up" },
      ownerCaller(),
    );
    if (sent.status !== "ok") throw new Error(JSON.stringify(sent));
    await h.settle();
    expect(await nextEntries(sent.result.conversationId)).toMatchObject([
      { payload: { replies: ["Send it"], outside: true } },
    ]);
    // The overlay is told, to mark them.
    expect(await shown(sent.result.conversationId)).toEqual({
      replies: ["Send it"],
      outside: true,
    });
  });

  it("aren't offered after Pip asked you something: a reply would race your answer", async () => {
    const f = fake(["Friday"]);
    await start(f.suggest);
    const ask = { question: "Which day suits you?", choices: ["Friday", "Monday"] };
    h.brain.next([{ call: "ask_owner", input: ask }, { say: `${DRAFT} Which day suits you?` }]);
    const sent = await h.kernel.execute<{ conversationId: string }>(
      "chat.send",
      { text: "book the dentist" },
      ownerCaller(),
    );
    if (sent.status !== "ok") throw new Error(JSON.stringify(sent));
    await h.settle();
    const cid = sent.result.conversationId;
    expect((await h.tdb.db.select().from(jarvisTurn))[0]!.outcome).toBe("ask");
    expect(f.asked).toEqual([]);
    expect(await nextEntries(cid)).toEqual([]);
  });

  it("are left out when you wrote while Pip was still answering", async () => {
    const f = fake(["Send it"]);
    await start(f.suggest);
    let cid = "";
    h.brain.next(async () => {
      await h.kernel.execute("chat.send", { conversationId: cid, text: "Friday" }, ownerCaller());
      return [{ say: DRAFT }];
    });
    h.brain.otherwise([{ say: "OK." }]);
    const sent = await h.kernel.execute<{ conversationId: string }>(
      "chat.send",
      { text: "draft a reply to Ana" },
      ownerCaller(),
    );
    if (sent.status !== "ok") throw new Error(JSON.stringify(sent));
    cid = sent.result.conversationId;
    await h.settle();
    expect(await nextEntries(cid)).toEqual([]);
  });
});

describe("making ready replies", () => {
  it("skips an answer that's short and closes the topic", () => {
    expect(closesTopic("Done.")).toBe(true);
    expect(closesTopic("Sent it to Ana, with the agenda attached and the room booked.")).toBe(true);
    expect(closesTopic("Want me to send it?")).toBe(false);
    expect(closesTopic(DRAFT)).toBe(false);
  });

  it("keeps two short, different replies from the model's lines", () => {
    expect(
      tidyReplies(["- Send it", "send it", "NONE", "x".repeat(61), "• Shorter", "Third"]),
    ).toEqual(["Send it", "Shorter"]);
  });

  it("asks Haiku once, with no tools, the web or a session", async () => {
    const brain = new ScriptedBrain().next([{ say: "Send it\nMake it shorter" }]);
    const { lines } = await brainReplies(brain)({
      asked: "draft it",
      reply: DRAFT,
      signal: AbortSignal.timeout(1000),
    });
    expect(tidyReplies(lines)).toEqual(["Send it", "Make it shorter"]);
    expect(brain.requests[0]).toMatchObject({
      model: modelForJob("next"),
      tools: [],
      web: false,
      sessionId: null,
      maxTurns: 1,
    });
    expect(modelForJob("next", {})).toMatchObject({ tier: "haiku", effort: "low" });
  });
});
