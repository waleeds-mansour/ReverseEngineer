// Spec 6 in real turns: your trigger fires a background turn of Pip's on an event of the kind you
// picked whose filter passes, with your words as its prompt. Outside content stays untrusted; it
// never fires on what Pip's own work led to, only once per event and only so often a day; it runs
// for its job, within the job's ceiling; and Pip's pause stops it.
import { approval, jarvisTurn, observation } from "@hearth/db";
import {
  type Caller,
  defineAction,
  defineModule,
  integrationCaller,
  jarvisCaller,
  ownerCaller,
  readEventsAfter,
  setSetting,
  systemCaller,
} from "@hearth/kernel";
import type { Timeline, TriggerList } from "@hearth/modules";
import { asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const probe = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: [],
  events: [],
  kernelEvents: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "It only makes things happen for the tests.",
  actions: [
    defineAction({
      name: "probe.happen",
      description: "Makes an event of any declared kind happen",
      input: z.object({ kind: z.string(), payload: z.record(z.string(), z.unknown()) }),
      risk: "internal",
      async handler(i, ctx) {
        ctx.emit({ kind: i.kind, payload: i.payload });
        return { ok: true };
      },
    }),
    defineAction({
      name: "probe.send",
      description: "Sends something to someone",
      input: z.object({ to: z.string() }),
      risk: "outward",
      summarize: (i) => `Send to ${i.to}`,
      handler: async () => ({ sent: true }),
    }),
  ],
});

let h: JarvisHarness;
beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z", { modules: [probe] }); // Thu 10 a.m.
});
afterEach(() => h.destroy());

const owner = ownerCaller();
const gmail = integrationCaller("google");
const run = async <T>(name: string, input: unknown): Promise<T> => {
  const res = await h.kernel.execute<T>(name, input, owner);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
};
const happen = async (kind: string, payload: Record<string, unknown>, caller: Caller = gmail) => {
  const res = await h.kernel.execute("probe.happen", { kind, payload }, caller);
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  await h.settle();
};
const email = (from: string, subject = "Hello", caller?: Caller) =>
  happen("mail.received", { threadId: "t1", from, subject }, caller);
const acme = (extra: Record<string, unknown> = {}) =>
  run<{ id: string }>("trigger.create", {
    name: "Acme emails",
    on: "mail.received",
    filter: { from: "ana@acme.com" },
    instructions: "Draft a reply and tell me.",
    ...extra,
  });
const turns = () =>
  h.tdb.db
    .select({
      id: jarvisTurn.id,
      trigger: jarvisTurn.trigger,
      mode: jarvisTurn.mode,
      origin: jarvisTurn.origin,
      status: jarvisTurn.status,
      skip: jarvisTurn.skipReason,
      roleId: jarvisTurn.roleId,
      prompt: jarvisTurn.prompt,
      context: jarvisTurn.context,
    })
    .from(jarvisTurn)
    .orderBy(asc(jarvisTurn.queuedAt));
const fired = async () => (await turns()).filter((t) => t.trigger === "trigger");

describe("a trigger", () => {
  it("fires a background turn with your words on an event that passes its filter", async () => {
    const t = await acme();
    h.brain.next([{ say: "Drafted a reply." }]);
    await email("Ana@Acme.com ", "Invoice 42");
    const [turn] = await fired();
    expect(turn).toMatchObject({
      mode: "proactive",
      status: "done",
      // An email's words are outside content, so the turn starts untrusted (D25).
      origin: "untrusted",
      context: expect.objectContaining({ triggerId: t.id, triggerName: "Acme emails" }),
    });
    expect(turn!.prompt).toContain('trigger "Acme emails" went off: an email arrives');
    expect(turn!.prompt).toContain("Draft a reply and tell me.");
    expect(turn!.prompt).toContain("- subject: Invoice 42");
    expect(h.brain.requests.at(-1)?.system).toContain("One of the owner's triggers went off");
    // What Pip did names the trigger that set it off.
    const timeline = await run<Timeline>("activity.timeline", {});
    expect(timeline.groups[0]?.turn).toMatchObject({
      trigger: "trigger",
      triggerName: "Acme emails",
    });
    expect(await run<TriggerList>("trigger.list", {})).toMatchObject({
      triggers: [{ name: "Acme emails", firedToday: 1, lastFiredAt: expect.any(Date) }],
    });
  });

  it("stays quiet for an event its filter doesn't pass, of another kind, or while it's off", async () => {
    const t = await acme();
    await email("bo@elsewhere.com");
    await happen("calendar.event_changed", { change: "added", title: "Lunch" });
    await run("trigger.update", { id: t.id, active: false });
    await email("ana@acme.com");
    expect(await turns()).toEqual([]);
  });

  it("never fires on what Pip's own work led to, so it can't loop", async () => {
    await acme();
    // Pip's turn itself sends mail.received's like (a sync it ran): skipped.
    await email("ana@acme.com", "Re: Hello", jarvisCaller("owner"));
    expect(await fired()).toEqual([]);
    // One real email: its turn does something that leads to another one from Ana.
    h.brain.next([
      { call: "probe_happen", input: { kind: "mail.received", payload: { from: "ana@acme.com" } } },
    ]);
    await email("ana@acme.com");
    const [first] = await fired();
    expect(first).toMatchObject({ status: "done" });
    // And what Hearth does as part of that turn's work, though not as Pip, is still Pip's doing.
    await email("ana@acme.com", "Auto-reply", systemCaller({ correlationId: first!.id }));
    expect(await fired()).toHaveLength(1);
  });

  it("fires once per event, however often the event is read", async () => {
    await acme();
    await email("ana@acme.com");
    const [event] = await readEventsAfter(h.kernel.db, 0, { kinds: ["mail.received"] });
    await h.engine.handle(event!);
    await h.settle();
    expect((await fired()).map((t) => [t.status, t.skip])).toEqual([
      ["done", null],
      ["skipped", "duplicate"],
    ]);
  });

  it("starts no more turns a day than its cap, and starts again the next day", async () => {
    const t = await acme({ perDay: 2 });
    for (let i = 0; i < 4; i++) await email("ana@acme.com", `Burst ${i}`);
    expect(await fired()).toHaveLength(2);
    expect(await run<TriggerList>("trigger.list", {})).toMatchObject({
      triggers: [{ id: t.id, perDay: 2, firedToday: 2 }],
    });
    h.clock.set("2026-10-02T14:00:00Z");
    await email("ana@acme.com", "Next day");
    expect(await fired()).toHaveLength(3);
  });

  it("stops while Pip is paused, and counts against Pip's own daily turns", async () => {
    await acme();
    await setSetting(h.tdb.db, "jarvis.paused", true);
    await email("ana@acme.com");
    expect(await turns()).toEqual([]);
    await setSetting(h.tdb.db, "jarvis.paused", false);
    await setSetting(h.tdb.db, "jarvis.proactiveTurnsPerDay", 0);
    await email("ana@acme.com");
    expect(await fired()).toMatchObject([{ status: "skipped", skip: "budget" }]);
  });

  it("skips Notion's first read of the board, which is no news", async () => {
    await run("trigger.create", {
      name: "New tickets",
      on: "notion.task_assigned",
      instructions: "Plan my day around it.",
    });
    await happen("notion.task_assigned", { title: "Old ticket", backfill: true });
    expect(await turns()).toEqual([]);
    await happen("notion.task_assigned", { title: "New ticket", backfill: false });
    expect(await fired()).toHaveLength(1);
  });
});

describe("a trigger for one of Pip's jobs", () => {
  const job = (input: Record<string, unknown>) => run<{ id: string }>("role.create", input);
  const assigned = () =>
    happen("task.assigned", { number: 7, title: "Call Ana", from: null, to: "owner" }, owner);
  const forPip = (roleId: string) =>
    run("trigger.create", {
      name: "My tasks",
      on: "task.assigned",
      filter: { to: "owner" },
      instructions: "Find what I need for it and let Ana know.",
      roleId,
    });

  it("runs its turn for the job: tagged, told, and held to the job's ceiling", async () => {
    const j = await job({ name: "Quiet", riskCeiling: "internal" });
    await forPip(j.id);
    let outputs: string[] = [];
    h.brain.next((_req, out) => {
      outputs = out;
      return [{ call: "probe_send", input: { to: "Ana" } }, { say: "Held the send." }];
    });
    await assigned();
    expect(await fired()).toMatchObject([{ roleId: j.id, status: "done", origin: "owner" }]);
    expect(h.brain.requests.at(-1)?.system).toContain("You're doing your Quiet job");
    expect(outputs[0]).toMatch(/so this was held for your brief\.$/);
    const sends = await h.tdb.db.select().from(approval).where(eq(approval.action, "probe.send"));
    expect(sends).toEqual([]);
    expect(await h.tdb.db.select({ text: observation.text }).from(observation)).toMatchObject([
      { text: expect.stringContaining("Send to Ana") },
    ]);
  });

  it("is held to reads while background work is read-only (Spec 5), job or not", async () => {
    await run("trigger.create", {
      name: "My tasks",
      on: "task.assigned",
      instructions: "Let Ana know.",
    });
    await setSetting(h.tdb.db, "jarvis.backgroundReadOnly", true);
    let outputs: string[] = [];
    h.brain.next((_req, out) => {
      outputs = out;
      return [{ call: "probe_send", input: { to: "Ana" } }, { say: "Held." }];
    });
    await assigned();
    expect(await fired()).toMatchObject([{ roleId: null, status: "done" }]);
    expect(outputs[0]).toMatch(/so this was held for your brief\.$/);
  });

  it("counts against the job's turns a day, and is paused while the job is off", async () => {
    const j = await job({ name: "Busy", riskCeiling: "outward", turnsPerDay: 1 });
    await forPip(j.id);
    await assigned();
    await assigned();
    expect((await fired()).map((t) => [t.status, t.skip])).toEqual([
      ["done", null],
      ["skipped", "budget"],
    ]);
    await run("role.update", { id: j.id, active: false });
    h.clock.set("2026-10-02T14:00:00Z");
    await assigned();
    expect(await fired()).toHaveLength(2);
  });
});
