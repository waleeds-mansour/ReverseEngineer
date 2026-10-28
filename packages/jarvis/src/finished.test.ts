// Finished-work cards (D85): a turn Pip ran on its own that changed something for you leaves a
// quiet card, saying what it was about and the first line of what it said. More from the same
// routine or job joins that card while it's unseen. Never for a turn you started by chatting, one
// that only read, noted or asked, one that already put a card in your inbox, Pip's own upkeep, or
// work picked up again in a conversation you're in.
import { jarvisTurn, notification, question, schedule, type TurnTrigger } from "@hearth/db";
import { newId, ownerCaller } from "@hearth/kernel";
import { firstLine } from "@hearth/modules";
import { asc, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScriptStep } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z");
  await h.tdb.db.delete(schedule).where(like(schedule.id, "routine:%"));
});
afterEach(() => h.destroy());

const MAKE_TASK: ScriptStep = { call: "task_create", input: { title: "Call Ana about the lease" } };
const cards = () =>
  h.tdb.db
    .select()
    .from(notification)
    .where(eq(notification.kind, "finished"))
    .orderBy(asc(notification.createdAt));
const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));

/** A turn of Pip's own, run with `steps`. */
async function ownTurn(
  steps: ScriptStep[],
  t: { trigger?: TurnTrigger; context?: Record<string, unknown> } = {},
) {
  h.brain.next(steps);
  // A second apart, so they line up in the order they ran.
  h.clock.advance(1000);
  const now = h.clock.now();
  const id = newId();
  await h.tdb.db.insert(jarvisTurn).values({
    id,
    trigger: t.trigger ?? "reflex",
    mode: "proactive",
    lane: "fast",
    origin: "system",
    prompt: "Look at what came in.",
    context: t.context ?? {},
    queuedAt: now,
    notBefore: now,
  });
  await h.settle();
  const [turn] = await h.tdb.db.select().from(jarvisTurn).where(eq(jarvisTurn.id, id));
  return turn!;
}

describe("finished-work cards", () => {
  it("says what a turn of Pip's own did, once, quietly", async () => {
    const turn = await ownTurn([
      MAKE_TASK,
      { say: "\n- Made a task to **call Ana** about the lease.\n\nAnything else?" },
    ]);
    expect(turn.outcome).toBe("act");
    expect(await cards()).toMatchObject([
      {
        title: "Pip finished something it noticed",
        body: "Made a task to call Ana about the lease.",
        urgency: "quiet",
        entityId: turn.conversationId,
        dedupeKey: `finished:reflex:${turn.id}`,
        outside: false,
        state: "unseen",
      },
    ]);
  });

  it("names a routine, and marks one that read outside content", async () => {
    await ownTurn([{ readWeb: "WebFetch", text: "a page" }, MAKE_TASK, { say: "Made a task." }], {
      trigger: "routine",
      context: { routine: "reply_drafts", source: "reply_drafts" },
    });
    expect(await cards()).toMatchObject([
      { title: "Pip finished reply drafts", body: "Made a task.", outside: true },
    ]);
  });

  it("leaves out turns that only read, noted or asked, and Pip's own upkeep", async () => {
    await ownTurn([{ call: "task_list", input: {} }, { say: "Nothing new." }]);
    await ownTurn([
      { call: "jarvis_observe", input: { kind: "fyi", text: "Ana wrote." } },
      { say: "Noted." },
    ]);
    await ownTurn([
      { call: "ask_owner", input: { question: "Call Ana today?", choices: ["Yes", "Later"] } },
      { say: "Asked." },
    ]);
    await ownTurn([MAKE_TASK, { say: "Remembered." }], {
      trigger: "routine",
      context: { routine: "memory" },
    });
    expect((await turns()).map((t) => t.outcome)).toEqual(["nothing", "note", "ask", "act"]);
    expect(await cards()).toEqual([]);
  });

  it("leaves out a turn that already put a card in your inbox", async () => {
    await ownTurn([
      MAKE_TASK,
      { call: "inbox_notify", input: { title: "Ana needs a call", urgency: "normal" } },
      { say: "Made a task and told you." },
    ]);
    expect(await cards()).toEqual([]);
  });

  it("never comes for what you asked in chat, nor for work picked up again there", async () => {
    h.brain.next([
      MAKE_TASK,
      {
        call: "ask_owner",
        input: { question: "Today or tomorrow?", choices: ["Today", "Tomorrow"] },
      },
      { say: "Made it; asked when." },
    ]);
    const sent = await h.kernel.execute(
      "chat.send",
      { text: "remind me to call Ana" },
      ownerCaller(),
    );
    expect(sent.status).toBe("ok");
    await h.settle();
    const [q] = await h.tdb.db.select().from(question);
    h.clock.advance(1000);
    await h.kernel.execute("question.answer", { id: q!.id, choice: 0 }, ownerCaller());
    h.brain.next([MAKE_TASK, { say: "Set for today." }]);
    await h.settle();
    expect((await turns()).map((t) => [t.trigger, t.outcome])).toEqual([
      ["chat", "act"],
      ["approval", "act"],
    ]);
    expect(await cards()).toEqual([]);
  });

  it("comes for work picked up again in a conversation of Pip's own", async () => {
    await ownTurn([
      { call: "ask_owner", input: { question: "Call Ana today?", choices: ["Yes", "Later"] } },
      { say: "Asked." },
    ]);
    const [q] = await h.tdb.db.select().from(question);
    await h.kernel.execute("question.answer", { id: q!.id, choice: 0 }, ownerCaller());
    h.brain.next([MAKE_TASK, { say: "Made a task to call Ana today." }]);
    await h.settle();
    expect(await cards()).toMatchObject([
      { title: "Pip finished what you decided", body: "Made a task to call Ana today." },
    ]);
  });
});

describe("finished work that piles up", () => {
  const HEARTBEAT = { routine: "heartbeat", source: "jarvis.heartbeat" };
  const beat = (line: string) =>
    ownTurn([MAKE_TASK, { say: line }], { trigger: "routine", context: HEARTBEAT });

  it("gathers a routine's runs on its unseen card, and starts another once you've seen it", async () => {
    for (const n of [1, 2, 3]) await beat(`Sorted mail, round ${n}.`);
    const last = await beat("Drafted a reply to Sam.");
    expect(await cards()).toMatchObject([
      {
        title: "Pip finished 4 things: its heartbeat",
        body: "Drafted a reply to Sam.",
        dedupeKey: `finished:routine/jarvis.heartbeat:${last.id}`,
        state: "unseen",
      },
    ]);
    // Something else of Pip's has a card of its own.
    await ownTurn([MAKE_TASK, { say: "Made a task." }]);
    expect((await cards()).map((c) => c.title)).toEqual([
      "Pip finished 4 things: its heartbeat",
      "Pip finished something it noticed",
    ]);
    const [card] = await cards();
    await h.kernel.execute("inbox.mark", { ids: [card!.id], state: "seen" }, ownerCaller());
    await beat("Archived two newsletters.");
    expect((await cards()).map((c) => [c.title, c.state])).toEqual([
      ["Pip finished 4 things: its heartbeat", "seen"],
      ["Pip finished something it noticed", "unseen"],
      ["Pip finished its heartbeat", "unseen"],
    ]);
  });
});

describe("a card's first line", () => {
  it("is the first line with words, without marks, and short", () => {
    expect(firstLine("\n\n### Summary\nrest")).toBe("Summary");
    expect(firstLine("1. **Drafted** three replies")).toBe("Drafted three replies");
    expect(firstLine("")).toBeNull();
    expect(firstLine(null)).toBeNull();
    expect(firstLine("x".repeat(300))).toHaveLength(200);
  });
});
