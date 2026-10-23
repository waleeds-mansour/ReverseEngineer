// What marks a turn as about code, so it runs on Opus (D82): the owner's ask in chat, a task
// about code (its work and its thread), and anything GitHub started.
import { entity, jarvisTurn } from "@hearth/db";
import { type HearthEvent, newId, ownerCaller } from "@hearth/kernel";
import { asc } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobOf } from "./models.ts";
import { applyOutcomes } from "./outcomes.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

describe("turns about code", () => {
  let h: JarvisHarness;
  beforeEach(async () => {
    h = await createJarvisHarness("2026-10-01T14:00:00Z");
  });
  afterEach(async () => {
    await h.destroy();
  });

  async function ok<T = { id: string }>(name: string, input: unknown): Promise<T> {
    const res = await h.kernel.execute<T>(name, input, ownerCaller());
    if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
    return res.result;
  }
  /** Each turn's job, oldest first, after letting it run. */
  async function jobs(): Promise<string[]> {
    for (let i = 0; i < 4; i++) h.brain.next([{ say: "On it." }]);
    await h.settle();
    const rows = await h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
    return rows.map((t) => jobOf(t));
  }

  it("runs a code ask in chat as code, and an everyday one as chat", async () => {
    await ok("chat.send", { text: "fix the bug in packages/jarvis/src/heartbeat.ts" });
    await ok("chat.send", { text: "build a schedule for my week" });
    expect(await jobs()).toEqual(["code", "chat.quick"]);
    expect(h.brain.requests[0]?.model).toMatchObject({ job: "code", model: "claude-opus-5-5" });
  });

  it("works a task about code, by its words or a linked pull request, as code", async () => {
    await ok("task.create", { title: "Fix the flaky test in runner.ts", assignee: "jarvis" });
    await ok("task.create", { title: "Book flights to Denver", assignee: "jarvis" });
    const pr = newId();
    await h.tdb.db.insert(entity).values({
      id: pr,
      type: "github_pr",
      title: "Heartbeat runs twice",
      createdBy: "system",
      updatedBy: "system",
    });
    const t = await ok("task.create", { title: "Look into this" });
    await ok("link.add", { fromId: t.id, toId: pr });
    await ok("task.update", { id: t.id, assignee: "jarvis" });
    expect(await jobs()).toEqual(["code", "task.work", "code"]);

    // Its thread too: you commenting on it is about the same code.
    await ok("comment.create", { parentId: t.id, body: "any luck?" });
    expect((await jobs()).at(-1)).toBe("code");
  });

  it("marks a turn GitHub started as code", async () => {
    const event = (kind: string): HearthEvent => ({
      seq: 0,
      id: newId(),
      at: h.clock.now(),
      kind,
      entityId: null,
      actor: "integration:github",
      origin: "untrusted",
      payload: {},
      correlationId: null,
      causationId: null,
    });
    const turn = { kind: "turn", trigger: "reflex", lane: "deep", prompt: "Look at it." } as const;
    for (const kind of ["github.pr_opened", "mail.received"])
      await applyOutcomes(h.kernel, [{ ...turn, dedupeKey: kind }], {
        event: event(kind),
        name: "test.reflex",
        mode: "reactive",
      });
    expect(await jobs()).toEqual(["code", "reflex"]);
  });
});
