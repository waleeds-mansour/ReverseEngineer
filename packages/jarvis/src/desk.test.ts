// Pip's desk, on Today: the turn Pip is working on, since when, and when it will be stopped if it
// hasn't finished (its lane's time, a voice command's, or the browser's once it has used it);
// what's waiting after it, in the order Pip takes them; Stop showing at once; claiming a turn
// saying so (jarvis.turn_started); and only you can read it.
import { TURN_LIMIT_MS } from "@hearth/core";
import { audit, event, jarvisTurn } from "@hearth/db";
import { jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import type { Desk, DeskTurn } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const START = Date.parse("2026-10-01T14:00:00Z");

let h: JarvisHarness;
beforeEach(async () => {
  h = await createJarvisHarness(new Date(START).toISOString());
});
afterEach(() => h.destroy());

async function ok<T>(name: string, input: unknown = {}) {
  const res = await h.kernel.execute<T>(name, input, ownerCaller());
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const desk = () => ok<Desk>("jarvis.desk");
/** How long the desk says a running turn has, from its start to its deadline. */
const limitOf = (t: DeskTurn | undefined) => +new Date(t!.deadline!) - +new Date(t!.startedAt!);

/** A turn waiting to run, queued `mins` minutes after the start. */
async function queue(t: Partial<typeof jarvisTurn.$inferInsert>, mins = 0): Promise<string> {
  const id = newId();
  const at = new Date(START + mins * 60_000);
  await h.tdb.db.insert(jarvisTurn).values({
    id,
    trigger: "chat",
    mode: "reactive",
    lane: "fast",
    origin: "owner",
    prompt: "",
    queuedAt: at,
    notBefore: at,
    ...t,
  });
  return id;
}

describe("Pip's desk", () => {
  it("shows what Pip is working on and till when, then what's waiting, in the order Pip takes them", async () => {
    const routine = await queue({
      trigger: "routine",
      mode: "proactive",
      context: { source: "brief" },
    });
    const deep = await queue({ lane: "deep", prompt: "Write up the offsite agenda" }, 1);
    const member = await queue({ trigger: "slack_member", origin: "untrusted" }, 2);
    const yours = await queue({ prompt: "What's on tomorrow?" }, 3);
    h.clock.set("2026-10-01T14:10:00Z");
    expect((await h.runner.claimNext())?.id).toBe(deep);

    const d = await desk();
    expect(d.running).toMatchObject([
      { id: deep, asked: "Write up the offsite agenda", stopping: false, browsing: false },
    ]);
    expect(limitOf(d.running[0])).toBe(TURN_LIMIT_MS.deep);
    expect(d.waiting.map((t) => t.id)).toEqual([yours, member, routine]);
    expect(d.waiting[2]).toMatchObject({ source: "brief", deadline: null });
    expect(d.waitingCount).toBe(3);
  });

  it("lists the first five waiting and counts the rest", async () => {
    for (let i = 0; i < 7; i++) await queue({ prompt: `Ask ${i}` }, i);
    const d = await desk();
    expect(d.running).toEqual([]);
    expect(d.waiting.map((t) => t.asked)).toEqual(["Ask 0", "Ask 1", "Ask 2", "Ask 3", "Ask 4"]);
    expect(d.waitingCount).toBe(7);
  });

  it("gives a voice command two minutes, and the browser's time once it has used the browser", async () => {
    const voice = await queue({ trigger: "voice_command", prompt: "Open my bank" });
    await h.runner.claimNext();
    expect(limitOf((await desk()).running[0])).toBe(TURN_LIMIT_MS.voice);

    await h.tdb.db.insert(audit).values({
      id: newId(),
      at: new Date(START + 30_000),
      principal: "jarvis",
      origin: "owner",
      via: "jarvis",
      action: "browser.navigate",
      risk: "self_external",
      outcome: "ok",
      correlationId: voice,
    });
    const [t] = (await desk()).running;
    expect(t).toMatchObject({ browsing: true });
    expect(limitOf(t)).toBe(TURN_LIMIT_MS.browser);
  });

  it("says a turn has started, as Pip", async () => {
    const id = await queue({ prompt: "hi" });
    await h.runner.claimNext();
    const started = await h.tdb.db
      .select()
      .from(event)
      .where(eq(event.kind, "jarvis.turn_started"));
    expect(started).toMatchObject([
      { actor: "jarvis", correlationId: id, payload: { turnId: id, trigger: "chat" } },
    ]);
  });

  it("shows Stop at once, and drops a waiting turn you stopped", async () => {
    const running = await queue({ prompt: "one" });
    const waiting = await queue({ prompt: "two" });
    await h.runner.claimNext();
    await ok("jarvis.cancel_turn", { turnId: running });
    await ok("jarvis.cancel_turn", { turnId: waiting });
    const d = await desk();
    expect(d.running).toMatchObject([{ id: running, stopping: true }]);
    expect(d.waiting).toEqual([]);
    expect(d.waitingCount).toBe(0);
  });

  it("is yours only", async () => {
    const res = await h.kernel.execute("jarvis.desk", {}, jarvisCaller("owner"));
    expect(res.status).not.toBe("ok");
  });
});
