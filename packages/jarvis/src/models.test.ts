// Which model does which job (D82): the tier map, the owner's overrides in .env, and a turn the
// model couldn't finish being taken over by the next one up, in the same session.
import { jarvisTurn } from "@hearth/db";
import { ownerCaller } from "@hearth/kernel";
import { asc } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { describeTiers, escalate, JOBS, jobOf, modelFor, modelForJob } from "./models.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";
import { leftWrong, OUT_OF_STEPS, TAKE_OVER } from "./turn-budget.ts";

const turn = (trigger: string, lane = "fast", context: Record<string, unknown> = {}) =>
  ({ trigger, lane, context }) as Parameters<typeof jobOf>[0];

describe("the job a turn does", () => {
  it("follows what started it", () => {
    expect(jobOf(turn("chat"))).toBe("chat.quick");
    expect(jobOf(turn("mention", "deep"))).toBe("chat.deep");
    expect(jobOf(turn("assignment", "deep"))).toBe("task.work");
    expect(jobOf(turn("assignment"))).toBe("task.thread");
    expect(jobOf(turn("voice_command"))).toBe("voice");
    expect(jobOf(turn("watch"))).toBe("watch");
    expect(jobOf(turn("reflex", "deep"))).toBe("reflex");
    expect(jobOf(turn("slack_member"))).toBe("slack_member");
    expect(modelFor(turn("trigger", "deep"), {})).toMatchObject({
      job: "trigger",
      tier: "sonnet",
    });
  });

  it("knows the built-in routines by name, and anything else is one of yours", () => {
    for (const r of [
      "brief",
      "journal",
      "memory",
      "prep",
      "reply_drafts",
      "follow_ups",
      "personas",
    ])
      expect(jobOf(turn("routine", "deep", { routine: r }))).toBe(r);
    // Every timed turn carries its schedule; the journal is still the journal.
    expect(jobOf(turn("routine", "deep", { routine: "journal", scheduleId: "s1" }))).toBe(
      "journal",
    );
    // Your routine carries your title, which could be "brief": the reflex says it's yours.
    expect(jobOf(turn("routine", "deep", { routine: "brief", source: "routine.due" }))).toBe(
      "routine",
    );
    expect(jobOf(turn("routine", "deep", { routine: "Check the garden" }))).toBe("routine");
  });

  it("runs anything marked as code on Opus, from the turns that can be about code", () => {
    const code = { code: true };
    for (const [trigger, lane] of [
      ["chat", "fast"],
      ["mention", "deep"],
      ["assignment", "deep"],
      ["assignment", "fast"],
      ["reflex", "deep"],
      ["watch", "fast"],
      // Your trigger on a pull request opening (Spec 6).
      ["trigger", "deep"],
    ] as const)
      expect(modelFor(turn(trigger, lane, code), {})).toMatchObject({ job: "code", tier: "opus" });
    // A Slack member, a card you answered or a voice command stays as it was.
    expect(jobOf(turn("slack_member", "fast", code))).toBe("slack_member");
    expect(jobOf(turn("approval", "fast", code))).toBe("approval");
    expect(jobOf(turn("voice_command", "fast", code))).toBe("voice");
  });

  it("drafts replies on Sonnet and sorts the rest of the heartbeat on Haiku", () => {
    const beat = (drafts?: boolean) =>
      modelFor(
        turn("routine", "fast", { routine: "heartbeat", ...(drafts ? { drafts } : {}) }),
        {},
      );
    expect(beat()).toMatchObject({ job: "heartbeat.triage", tier: "haiku" });
    expect(beat(true)).toMatchObject({ job: "heartbeat.drafts", model: "claude-sonnet-5-5" });
  });
});

describe("the tier map", () => {
  it("runs each tier on its 5.5 model, with the job's effort", () => {
    expect(modelForJob("voice", {})).toEqual({
      job: "voice",
      tier: "haiku",
      model: "claude-haiku-5-5",
      effort: "low",
    });
    expect(modelForJob("chat.deep", {})).toMatchObject({ model: "claude-sonnet-5-5" });
    expect(modelForJob("task.work", {})).toEqual({
      job: "task.work",
      tier: "opus",
      model: "claude-opus-5-5",
    });
  });

  it("keeps Opus for the work Pip does alone and for code", () => {
    const onOpus = Object.entries(JOBS).filter(([, j]) => j.tier === "opus");
    expect(onOpus.map(([name]) => name)).toEqual(["task.work", "code"]);
  });

  it("lets the owner point a tier at another model, or move a job, from .env", () => {
    const env = {
      HEARTH_MODEL_OPUS: "claude-sonnet-5-5",
      HEARTH_JARVIS_JOBS: " Brief=opus, watch=sonnet, nope=haiku, journal=gpt ",
    };
    expect(modelForJob("brief", env)).toMatchObject({ tier: "opus", model: "claude-sonnet-5-5" });
    expect(modelForJob("watch", env)).toMatchObject({ tier: "sonnet" });
    // A name it doesn't know, or a tier that isn't one, changes nothing.
    expect(modelForJob("journal", env)).toMatchObject({ tier: "sonnet" });
    expect(describeTiers(env)).toBe(
      "haiku claude-haiku-5-5, sonnet claude-sonnet-5-5, opus claude-sonnet-5-5; moved: brief on opus, watch on sonnet",
    );
  });

  it("goes up one tier, once, and never past Opus", () => {
    const up = escalate(modelForJob("watch", {}), {});
    expect(up).toMatchObject({ job: "watch", tier: "sonnet", escalated: true });
    expect(escalate(up!, {})).toBeNull();
    expect(escalate(modelForJob("brief", {}), {})).toMatchObject({ tier: "opus" });
    expect(escalate(modelForJob("task.work", {}), {})).toBeNull();
  });
});

describe("a turn the model couldn't finish", () => {
  let h: JarvisHarness;
  const saved = process.env.HEARTH_JARVIS_JOBS;
  afterEach(async () => {
    if (saved === undefined) delete process.env.HEARTH_JARVIS_JOBS;
    else process.env.HEARTH_JARVIS_JOBS = saved;
    await h.destroy();
  });

  async function chatOn(tier: string) {
    process.env.HEARTH_JARVIS_JOBS = `chat.quick=${tier}`;
    h = await createJarvisHarness("2026-10-01T14:00:00Z");
    const res = await h.kernel.execute(
      "chat.send",
      { text: "add a task to call the bank" },
      ownerCaller(),
    );
    if (res.status !== "ok") throw new Error(JSON.stringify(res));
  }
  const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
  const wrong = { call: "task_create", input: { dueAt: "tomorrow" } };
  const right = { call: "task_create", input: { title: "Call the bank" } };

  it("is taken over by Sonnet in the same session when Haiku got a call wrong", async () => {
    await chatOn("haiku");
    h.brain.next([wrong, { say: "That didn't work." }]);
    h.brain.next([right, { say: "Added it." }]);
    await h.settle();

    const [first, second] = h.brain.requests;
    expect(first?.model).toMatchObject({ tier: "haiku", model: "claude-haiku-5-5" });
    expect(second).toMatchObject({
      prompt: TAKE_OVER,
      sessionId: "scripted-session",
      model: { tier: "sonnet", escalated: true },
    });
    expect((await turns())[0]).toMatchObject({ status: "done", reply: "Added it." });
  });

  it("is taken over when Haiku runs out of steps, but not when it put its call right", async () => {
    await chatOn("haiku");
    h.brain.next([{ say: "Thinking." }, { outOfSteps: 40 }]);
    h.brain.next([right, { say: "Added it." }]);
    await h.settle();
    expect(h.brain.requests.map((r) => r.model?.tier)).toEqual(["haiku", "sonnet"]);

    await h.kernel.execute("chat.send", { text: "and the dentist" }, ownerCaller());
    h.brain.next([wrong, { ...right, input: { title: "Dentist" } }, { say: "Added." }]);
    await h.settle();
    expect(h.brain.requests).toHaveLength(3);
  });

  it("goes from Sonnet to Opus only for a call it left wrong, not for running long", async () => {
    await chatOn("sonnet");
    h.brain.next([wrong, { say: "Hmm." }]);
    h.brain.next([right, { say: "Added it." }]);
    await h.settle();
    expect(h.brain.requests.map((r) => r.model?.tier)).toEqual(["sonnet", "opus"]);

    await h.kernel.execute("chat.send", { text: "now plan the rest" }, ownerCaller());
    h.brain.next([right, { outOfSteps: 40 }]);
    await h.settle();
    expect(h.brain.requests).toHaveLength(3);
    expect((await turns())[1]).toMatchObject({ status: "done", reply: OUT_OF_STEPS });
  });
});

describe("a call the model left wrong", () => {
  const call = (status: string, code?: string, action = "task.create") => ({
    action,
    status,
    ...(code ? { code } : {}),
  });

  it("is bad input, an unknown action or a missing record, not put right later", () => {
    expect(leftWrong([call("error", "invalid_input")])).toBe(true);
    expect(leftWrong([call("error", "not_found"), call("ok", undefined, "note.create")])).toBe(
      true,
    );
    expect(leftWrong([call("error", "invalid_input"), call("ok")])).toBe(false);
  });

  it("isn't an outage or a refusal: a stronger model can't fix one and mustn't push past one", () => {
    for (const code of ["unavailable", "failed", "forbidden", "conflict"])
      expect(leftWrong([call("error", code)])).toBe(false);
    expect(leftWrong([call("denied"), call("pending_approval")])).toBe(false);
  });
});
