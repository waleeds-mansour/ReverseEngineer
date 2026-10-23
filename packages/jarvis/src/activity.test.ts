// What Pip did, as one timeline (Spec 1): a turn and everything it did read as one card, with
// each action's risk and outcome, the approval it asked for and how that went, the records it
// made, and its reply. A reflex's own action is a card of its own; your own changes aren't Pip's;
// the heartbeat's items show under the turn that took them up, or as waiting; and only you can
// read it, since the audit log holds every input Pip sent.
import { heartbeatItem, jarvisTurn } from "@hearth/db";
import {
  type Caller,
  defineAction,
  defineModule,
  jarvisCaller,
  newId,
  ownerCaller,
} from "@hearth/kernel";
import type { Timeline, TimelineGroup } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

/** Something outward, so Pip has to ask first. */
const probe = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: [],
  events: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    defineAction({
      name: "probe.send",
      description: "Send a test message out",
      input: z.object({ to: z.string() }),
      risk: "outward",
      summarize: (i) => `Send a note to ${i.to}`,
      handler: async () => ({ sent: true }),
    }),
  ],
});

let h: JarvisHarness;
beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z", { modules: [probe] });
  h.brain.otherwise(() => [{ say: "Sent it." }]);
});
afterEach(() => h.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const timeline = (input: unknown = {}) => ok<Timeline>("activity.timeline", input);
const byTrigger = (t: Timeline, trigger: string) =>
  t.groups.find((g) => g.turn?.trigger === trigger) as TimelineGroup;

/** You ask; Pip makes a task and asks before sending a note. */
async function askPip() {
  h.brain.next([
    { call: "task_create", input: { title: "Call Sam about the invoice" } },
    { call: "probe_send", input: { to: "Sam" } },
    { say: "Made a task, and asked you before sending Sam a note." },
  ]);
  await ok("chat.send", { text: "Remind me to call Sam, and let him know" });
  await h.settle();
}

describe("the timeline", () => {
  it("shows a turn as one card: what you asked, its actions, the approval, what it made, its reply", async () => {
    await askPip();
    const card = byTrigger(await timeline(), "chat");
    expect(card.id).toBe(card.turn!.id);
    expect(card.turn).toMatchObject({
      asked: "Remind me to call Sam, and let him know",
      status: "done",
      reply: "Made a task, and asked you before sending Sam a note.",
    });
    expect(card.actions.map((a) => [a.action, a.risk, a.outcome])).toEqual(
      expect.arrayContaining([
        ["task.create", "internal", "ok"],
        ["probe.send", "outward", "pending_approval"],
      ]),
    );
    expect(card.actions.find((a) => a.action === "task.create")?.what).toBe(
      "Call Sam about the invoice",
    );
    expect(card.approvals).toMatchObject([{ summary: "Send a note to Sam", status: "pending" }]);
    expect(card.touched).toMatchObject([
      { type: "task", title: "Call Sam about the invoice", how: "made" },
    ]);
  });

  it("says the title of a record an action names, over the words in its input", async () => {
    const { id } = await ok<{ id: string }>("task.create", { title: "Pay the plumber" });
    h.brain.next([
      { call: "task_update", input: { id, body: "Paid by card on the 3rd", status: "completed" } },
      { say: "Marked it done." },
    ]);
    await ok("chat.send", { text: "I paid the plumber" });
    await h.settle();
    const card = byTrigger(await timeline(), "chat");
    expect(card.actions.find((a) => a.action === "task.update")?.what).toBe("Pay the plumber");
  });

  it("keeps an approval's run on the card that asked, even once that turn is off the page", async () => {
    await askPip();
    const asked = byTrigger(await timeline(), "chat");
    h.clock.set("2026-10-01T14:10:00Z");
    await h.kernel.decideApproval(asked.approvals[0]!.id, "approve", ownerCaller());
    await h.settle();
    // Only the newest turn (Pip picking up after your yes) is on the page, and the card that
    // asked comes with it, since its approval ran in the window.
    const page = await timeline({ limit: 1 });
    expect(page.groups.map((g) => g.turn?.trigger).sort()).toEqual(["approval", "chat"]);
    const card = byTrigger(page, "chat");
    expect(card.approvals).toMatchObject([{ status: "executed" }]);
    expect(card.actions.filter((a) => a.action === "probe.send").map((a) => a.outcome)).toEqual([
      "pending_approval",
      "ok",
    ]);
  });

  it("gives a reflex's own action a card of its own, and leaves your changes out", async () => {
    const correlationId = newId();
    await ok("task.create", { title: "Pay rent" }, jarvisCaller("owner", { correlationId }));
    await ok("task.create", { title: "Buy milk" });
    const t = await timeline();
    expect(t.groups).toHaveLength(1);
    expect(t.groups[0]).toMatchObject({
      id: correlationId,
      turn: null,
      actions: [{ action: "task.create", outcome: "ok", what: "Pay rent" }],
      touched: [{ title: "Pay rent", how: "made" }],
    });
  });

  it("puts heartbeat items under the turn that took them up, and lists the ones still waiting", async () => {
    const now = new Date("2026-10-01T14:00:00Z");
    const [taken, waiting] = [newId(), newId()];
    await h.tdb.db.insert(heartbeatItem).values([
      { id: taken, text: "Sam emailed about the invoice", origin: "system", createdAt: now },
      { id: waiting, text: "Ana asked about Friday in Slack", origin: "system", createdAt: now },
    ]);
    const turnId = newId();
    await h.tdb.db.insert(jarvisTurn).values({
      id: turnId,
      trigger: "routine",
      mode: "proactive",
      lane: "fast",
      origin: "system",
      prompt: "Heartbeat.",
      context: { routine: "heartbeat", source: "jarvis.heartbeat", itemIds: [taken] },
      status: "done",
      outcome: "nothing",
      queuedAt: now,
      finishedAt: now,
    });
    await h.tdb.db.update(heartbeatItem).set({ takenAt: now }).where(eq(heartbeatItem.id, taken));
    const t = await timeline();
    expect(t.groups[0]).toMatchObject({
      id: turnId,
      turn: { source: "jarvis.heartbeat", asked: null },
      setAside: [{ id: taken, text: "Sam emailed about the invoice" }],
    });
    expect(t.waiting).toMatchObject([{ id: waiting }]);
  });

  it("pages back by turn", async () => {
    const at = (min: number) => new Date(Date.parse("2026-10-01T13:00:00Z") + min * 60_000);
    const ids = [newId(), newId(), newId()];
    await h.tdb.db.insert(jarvisTurn).values(
      ids.map((id, i) => ({
        id,
        trigger: "chat" as const,
        mode: "reactive" as const,
        lane: "fast" as const,
        origin: "owner" as const,
        prompt: `Question ${i}`,
        status: "done" as const,
        queuedAt: at(i * 10),
      })),
    );
    const first = await timeline({ limit: 2 });
    expect(first.groups.map((g) => g.turn?.asked)).toEqual(["Question 2", "Question 1"]);
    expect(first.next).toBe(at(10).toISOString());
    const second = await timeline({ limit: 2, before: first.next });
    expect(second.groups.map((g) => g.turn?.asked)).toEqual(["Question 0"]);
    expect(second.next).toBeNull();
    expect(second.waiting).toEqual([]);
  });

  it("is yours alone to read", async () => {
    const res = await h.kernel.execute("activity.timeline", {}, jarvisCaller("owner"));
    expect(res.status).not.toBe("ok");
  });
});
