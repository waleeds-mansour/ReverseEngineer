// Spec 3 in real turns: a reflex or routine in one of Pip's jobs runs for the job. Its turns are
// tagged, told about the job, held to its ceiling (noted for the brief, never asked about) and
// counted against its own turns a day; a job that's off pauses what's in it. What's in no job runs
// exactly as before.
import { approval, jarvisTurn, observation } from "@hearth/db";
import { defineAction, defineModule, ownerCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const probe = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: [],
  events: [{ kind: "probe.poked", description: "Something to look into" }],
  knowledge: {},
  reflexes: [
    {
      name: "probe.look_into",
      description: "Looks into what was poked",
      mode: "proactive",
      on: ["probe.poked"],
      run: (e) => [
        {
          kind: "turn",
          trigger: "reflex",
          lane: "fast",
          prompt: "Look into it.",
          dedupeKey: `look:${e.seq}`,
        },
      ],
    },
    {
      name: "probe.reach_out",
      description: "Reaches out on its own",
      mode: "proactive",
      on: ["probe.poked"],
      run: () => [{ kind: "act", action: "probe.send", input: { to: "Bo" } }],
    },
  ],
  actions: [
    defineAction({
      name: "probe.poke",
      description: "Pokes",
      input: z.object({}),
      risk: "internal",
      async handler(_i, ctx) {
        ctx.emit({ kind: "probe.poked" });
        return { poked: true };
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
const run = async <T>(name: string, input: unknown): Promise<T> => {
  const res = await h.kernel.execute<T>(name, input, owner);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
};
const makeJob = (input: Record<string, unknown>) => run<{ id: string }>("role.create", input);
const poke = async () => {
  await h.kernel.execute("probe.poke", {}, owner);
  await h.settle();
};
const sends = () => h.tdb.db.select().from(approval).where(eq(approval.action, "probe.send"));
const notes = () => h.tdb.db.select({ text: observation.text }).from(observation);
const turns = () =>
  h.tdb.db
    .select({ roleId: jarvisTurn.roleId, status: jarvisTurn.status, skip: jarvisTurn.skipReason })
    .from(jarvisTurn)
    .orderBy(jarvisTurn.queuedAt);

describe("a reflex in one of Pip's jobs", () => {
  it("runs its turn for the job: tagged, told, and held to the job's ceiling", async () => {
    const job = await makeJob({
      name: "Outreach",
      riskCeiling: "internal",
      personaNote: "Be warm and brief.",
    });
    await run("role.attach", { id: job.id, reflex: "probe.look_into" });
    let system = "";
    let outputs: string[] = [];
    h.brain.next((req, out) => {
      system = req.system;
      outputs = out;
      return [
        { call: "probe_send", input: { to: "Ana" } },
        { call: "probe_send", input: { to: "Ana" } },
        { call: "jarvis_observe", input: { kind: "finding", text: "Ana is back." } },
        { say: "Held the send." },
      ];
    });
    // probe.reach_out isn't in the job: its act asks, as before.
    await poke();
    const reason = "Pip's Outreach job only reads and changes things in Nook";
    expect(system).toContain("You're doing your Outreach job");
    expect(system).toContain("For this job the owner wrote: Be warm and brief.");
    expect(outputs[0]).toBe(`Not allowed: ${reason}, so this was held for your brief.`);
    // A report stays within any ceiling.
    expect(outputs[2]).not.toMatch(/Not allowed/);
    expect(await turns()).toMatchObject([{ roleId: job.id, status: "done" }]);
    // Noted once for the brief; only the reach-out outside the job asked.
    expect((await notes()).map((n) => n.text).sort()).toEqual([
      "Ana is back.",
      `Held because ${reason}: Send to Ana`,
    ]);
    expect(await sends()).toMatchObject([{ summary: "Send to Bo" }]);
  });

  it("holds a reflex's own act to the job's ceiling, and notes it", async () => {
    const job = await makeJob({ name: "Quiet", riskCeiling: "read" });
    await run("role.attach", { id: job.id, reflex: "probe.reach_out" });
    h.brain.next([{ say: "Looked." }]);
    await poke();
    expect(await sends()).toEqual([]);
    expect(await notes()).toMatchObject([
      { text: "Held because Pip's Quiet job only reads: Send to Bo" },
    ]);
    // The turn from the reflex outside the job is untagged, as before.
    expect(await turns()).toMatchObject([{ roleId: null, status: "done" }]);
  });

  it("counts the job's turns against its own allowance, and nothing else's", async () => {
    const job = await makeJob({ name: "Busy", riskCeiling: "outward", turnsPerDay: 1 });
    await run("role.attach", { id: job.id, reflex: "probe.look_into" });
    h.brain.next([{ say: "One." }]);
    await poke();
    await poke();
    expect(await turns()).toMatchObject([
      { roleId: job.id, status: "done" },
      { roleId: job.id, status: "skipped", skip: "budget" },
    ]);
    expect(await run("role.list", {})).toMatchObject({
      roles: expect.arrayContaining([expect.objectContaining({ name: "Busy", turnsToday: 1 })]),
    });
    // Out of the job, the same reflex runs on the global allowance again.
    await run("role.detach", { id: job.id, reflex: "probe.look_into" });
    h.brain.next([{ say: "Two." }]);
    await poke();
    expect((await turns()).at(-1)).toMatchObject({ roleId: null, status: "done" });
  });

  it("pauses what's in a job that's off, and runs it again once it's on", async () => {
    const job = await makeJob({ name: "Paused", riskCeiling: "outward" });
    await run("role.attach", { id: job.id, reflex: "probe.look_into" });
    await run("role.attach", { id: job.id, reflex: "probe.reach_out" });
    await run("role.update", { id: job.id, active: false });
    await poke();
    expect(await turns()).toEqual([]);
    expect(await sends()).toEqual([]);
    await run("role.update", { id: job.id, active: true });
    h.brain.next([{ say: "Back." }]);
    await poke();
    expect(await turns()).toMatchObject([{ roleId: job.id, status: "done" }]);
    expect(await sends()).toHaveLength(1);
  });
});

describe("a routine in one of Pip's jobs", () => {
  const makeRoutine = () =>
    run<{ id: string }>("routine.create", {
      title: "Grades",
      instructions: "Check the school portal for new grades and tell me.",
      when: { every: "weekday", at: "07:00" },
    });

  it("runs its turn for the job, and is paused while the job is off, but Run now runs", async () => {
    const job = await makeJob({ name: "School", riskCeiling: "read" });
    const routine = await makeRoutine();
    await run("role.attach", { id: job.id, routineId: routine.id });
    await run("role.update", { id: job.id, active: false });
    h.clock.set("2026-10-02T11:00:30Z");
    await h.settle();
    expect(await turns()).toEqual([]);
    // You asked for it now, so it runs for the job though the job is off.
    h.brain.next([{ say: "No new grades." }]);
    await run("routine.run_now", { id: routine.id });
    await h.settle();
    expect(await turns()).toMatchObject([{ roleId: job.id, status: "done" }]);
    expect(h.brain.requests.at(-1)?.system).toContain(
      "You're doing your School job, which only reads",
    );
  });

  it("runs as before when it's in no job", async () => {
    await makeRoutine();
    h.brain.next([{ say: "No new grades." }]);
    h.clock.set("2026-10-02T11:00:30Z");
    await h.settle();
    expect(await turns()).toMatchObject([{ roleId: null, status: "done" }]);
    expect(h.brain.requests.at(-1)?.system).not.toContain("You're doing your");
  });
});
