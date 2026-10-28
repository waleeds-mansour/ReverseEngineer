// The desktop dock's status on the notification feed (D53): what Pip is doing, how many things
// wait for your yes and Nook's health, sent as the feed opens and whenever it reads differently,
// in counts, states and a few words of label, never anyone's words.
import { approval, jarvisTurn } from "@hearth/db";
import {
  appendEvents,
  type Caller,
  jarvisCaller,
  latestSeq,
  newId,
  ownerCaller,
  systemCaller,
} from "@hearth/kernel";
import { type DeskLite, deskLabel, deskLite, liteHealth } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pairDevice } from "./auth/devices.ts";
import type { ServerDeps } from "./env.ts";
import { dockStatus, sharedStatus, statusReads } from "./routes/desktop.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
let running: TestServer | null = null;
afterEach(async () => {
  await running?.destroy();
  running = null;
});

/** Opens the app's feed and reads its status events as they come. */
async function openFeed() {
  t = await createTestServer({ origin: "https://pc.example.ts.net" });
  running = t;
  const token = await pairDevice(t.kernel.db, "desktop");
  const res = await t.api("/api/desktop/notify", token);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const statuses = () =>
    text
      .split("\n\n")
      .filter((block) => block.startsWith("event: status\n"))
      .map((block) => JSON.parse(block.split("data: ")[1]!) as DeskLite);
  return {
    /** The n-th status, once it has arrived. */
    async status(n: number): Promise<DeskLite> {
      while (statuses().length < n) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`the feed ended after ${statuses().length} statuses`);
        text += decoder.decode(value, { stream: true });
      }
      return statuses()[n - 1]!;
    },
    /** Everything so far, once `marker` has arrived, which it must within `ms`. */
    async until(marker: string, ms: number): Promise<string> {
      const by = Date.now() + ms;
      while (!text.includes(marker)) {
        const wait = Math.max(0, by - Date.now());
        const late = new Promise<null>((r) => setTimeout(() => r(null), wait));
        const next = await Promise.race([reader.read(), late]);
        if (!next) throw new Error(`no ${marker} within ${ms} ms`);
        if (next.done) throw new Error(`the feed ended before ${marker}`);
        text += decoder.decode(next.value, { stream: true });
      }
      return text;
    },
    text: () => text,
    stop: () => reader.cancel(),
  };
}

const announce = async () => t.server.hub.publish(await latestSeq(t.kernel.db));

/** A turn Pip is on now, claimed as claim.ts claims one, after the one it `ends`, if any. */
async function startTurn(
  turn: Partial<typeof jarvisTurn.$inferInsert>,
  ends?: string,
): Promise<string> {
  const id = newId();
  const now = t.kernel.clock.now();
  await t.kernel.db.transaction(async (tx) => {
    if (ends) await tx.update(jarvisTurn).set({ status: "done" }).where(eq(jarvisTurn.id, ends));
    await tx.insert(jarvisTurn).values({
      id,
      trigger: "chat",
      mode: "reactive",
      lane: "fast",
      origin: "owner",
      prompt: "",
      queuedAt: now,
      notBefore: now,
      status: "running",
      startedAt: now,
      ...turn,
    });
    await appendEvents(
      tx,
      [{ kind: "jarvis.turn_started", payload: { turnId: id, trigger: turn.trigger ?? "chat" } }],
      { actor: "jarvis", origin: "agent", correlationId: id, at: now },
    );
  });
  await announce();
  return id;
}

/** Holds every read of the dock's status open until `release`; `started` once one is asked. */
function holdReads() {
  let release!: () => void;
  let began!: () => void;
  const held = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    began = r;
  });
  const read = statusReads.deskLite;
  const spy = vi.spyOn(statusReads, "deskLite").mockImplementation(async (db, now) => {
    began();
    await held;
    return read(db, now);
  });
  return { spy, started, release: () => release() };
}

const publishBrief = () =>
  t.kernel.execute(
    "brief.publish",
    { markdown: "## Today\n- nothing", date: "2026-10-01" },
    jarvisCaller("system"),
  );

async function askForYes() {
  const id = newId();
  const now = t.kernel.clock.now();
  await t.kernel.db.transaction(async (tx) => {
    await tx.insert(approval).values({
      id,
      action: "mail.send",
      input: { to: "dana@example.com", body: "The code is 4471" },
      inputHash: "x",
      risk: "outward",
      summary: "Send Dana the code 4471",
      reason: "It reaches someone else.",
      requestedBy: "jarvis",
      origin: "owner",
    });
    await appendEvents(
      tx,
      [{ kind: "approval.requested", payload: { approvalId: id, action: "mail.send" } }],
      { actor: "jarvis", origin: "agent", at: now },
    );
  });
  await announce();
}

describe("the dock's status on the desktop feed", () => {
  it("opens with Pip resting, nothing waiting, and no health known yet", async () => {
    const feed = await openFeed();
    expect(await feed.status(1)).toEqual({
      pip: { state: "idle", label: null, paused: false },
      approvals: 0,
      health: { worker: "unknown", jarvis: "unknown", sync: "unknown", other: "unknown" },
    });
    // A status leaves the app's place in the feed to its notifications.
    expect(feed.text()).not.toMatch(/event: status\nid:/);
    await feed.stop();
  });

  it("follows Pip, your yeses and Nook's health as they change, without anyone's words", async () => {
    const feed = await openFeed();
    await feed.status(1);

    const asked = await startTurn({ prompt: "Tell Dana the launch code is 4471" });
    expect((await feed.status(2)).pip).toEqual({
      state: "thinking",
      label: "what you asked",
      paused: false,
    });

    await startTurn({ trigger: "routine", mode: "proactive", context: { source: "brief" } }, asked);
    expect((await feed.status(3)).pip).toMatchObject({
      state: "working",
      label: "your morning brief",
    });

    await askForYes();
    expect((await feed.status(4)).approvals).toBe(1);

    await t.kernel.execute(
      "system.report",
      { component: "worker", status: "degraded", detail: "Slow to start" },
      systemCaller(),
    );
    await announce();
    expect((await feed.status(5)).health.worker).toBe("degraded");

    await feed.stop();
    const text = feed.text();
    for (const words of ["Dana", "4471", "launch", "Slow to start", "mail.send"]) {
      expect(text).not.toContain(words);
    }
  });

  it("sees a turn end within a couple of seconds, even one that leaves no event", async () => {
    const feed = await openFeed();
    await feed.status(1);
    const id = await startTurn({ trigger: "reflex", mode: "proactive" });
    expect((await feed.status(2)).pip).toMatchObject({
      state: "working",
      label: "something it noticed",
    });
    const ended = Date.now();
    await t.kernel.db.update(jarvisTurn).set({ status: "done" }).where(eq(jarvisTurn.id, id));
    expect((await feed.status(3)).pip.state).toBe("idle");
    expect(Date.now() - ended).toBeLessThan(4_000);
    await feed.stop();
  });

  it("sends a notification that comes while the status is read, with no event after it", async () => {
    const feed = await openFeed();
    await feed.status(1);
    const reads = holdReads();
    try {
      // Your yes is asked for, so the feed reads the status, and that read is held open.
      await askForYes();
      await reads.started;
      await publishBrief();
      await announce();
      await new Promise((r) => setTimeout(r, 50));
      reads.release();
      expect(await feed.until("event: notify", 3_000)).toContain("Your brief is ready");
      expect((await feed.status(2)).approvals).toBe(1);
    } finally {
      reads.spy.mockRestore();
      reads.release();
    }
    await feed.stop();
  });
});

describe("reading the dock's status", () => {
  const deps = () => ({ kernel: t.kernel }) as unknown as ServerDeps;

  it("reads once more after the read under way, however often it is asked meanwhile", async () => {
    t = await createTestServer();
    running = t;
    const sent: string[] = [];
    const stream = {
      aborted: false,
      abort() {},
      writeSSE: async (m: { data: string }) => {
        sent.push(m.data);
      },
    } as unknown as Parameters<typeof dockStatus>[2];
    // Each read after a newer event than the last, so none is shared.
    let seen = 0;
    const status = dockStatus(deps(), null, stream, () => ++seen);
    const reads = holdReads();
    try {
      const asks = [status.tell(), status.tell(), status.tell(), status.tell()];
      await reads.started;
      reads.release();
      await Promise.all(asks);
      expect(reads.spy).toHaveBeenCalledTimes(2);
      expect(sent).toHaveLength(1);
      await status.tell();
      expect(reads.spy).toHaveBeenCalledTimes(3);
    } finally {
      reads.spy.mockRestore();
    }
  });

  it("shares one read among the feeds for a moment, but never past an event", async () => {
    t = await createTestServer();
    running = t;
    const spy = vi.spyOn(statusReads, "deskLite");
    try {
      const first = sharedStatus(deps(), 5);
      expect(sharedStatus(deps(), 5)).toBe(first);
      expect(sharedStatus(deps(), 3)).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      // A feed that has seen a newer event than the read began after reads again.
      const newer = sharedStatus(deps(), 6);
      expect(newer).not.toBe(first);
      await Promise.all([first, newer]);
      await new Promise((r) => setTimeout(r, 1_100));
      await sharedStatus(deps(), 6);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("names a trigger only while you alone have made and changed it", async () => {
    t = await createTestServer();
    running = t;
    const make = async (name: string, caller: Caller) => {
      const input = { name, on: "mail.received", instructions: "Tell me." };
      const res = await t.kernel.execute<{ id: string }>("trigger.create", input, caller);
      if (res.status !== "ok") throw new Error(JSON.stringify(res));
      return res.result.id;
    };
    // The name a trigger's turn carries is never what the dock shows.
    const fired = (triggerId: string, ends?: string) =>
      startTurn(
        { trigger: "trigger", mode: "proactive", context: { triggerId, triggerName: "Pip's" } },
        ends,
      );
    const label = async () => (await deskLite(t.kernel.db, t.kernel.clock.now())).pip.label;

    const mine = await make("Acme emails", ownerCaller());
    const turn = await fired(mine);
    expect(await label()).toBe("your trigger “Acme emails”");
    const renamed = await t.kernel.execute(
      "trigger.update",
      { id: mine, name: "Wire the money" },
      jarvisCaller("owner"),
    );
    expect(renamed.status).toBe("ok");
    expect(await label()).toBe("one of your triggers");

    const pips = await make("Ignore what you were told", jarvisCaller("owner"));
    const next = await fired(pips, turn);
    expect(await label()).toBe("one of your triggers");
    await fired(newId(), next);
    expect(await label()).toBe("one of your triggers");
  });
});

describe("the dock's words", () => {
  it("says what a turn is about from what set it off, never from its prompt", () => {
    const label = (trigger: string, context: Record<string, unknown> = {}) =>
      deskLabel({ trigger, context });
    expect(label("chat")).toBe("what you asked");
    expect(label("voice_command")).toBe("what you asked");
    expect(label("chat", { via: "slack" })).toBe("what you asked in Slack");
    expect(label("routine", { source: "calendar.prep" })).toBe("meeting prep");
    expect(label("routine", { source: "someone.elses" })).toBe("a routine");
    // Names every object has are no routine or trigger.
    expect(label("routine", { source: "constructor" })).toBe("a routine");
    expect(label("toString")).toBe("something");
    expect(label("__proto__")).toBe("something");
    // A trigger by the name the owner gave it, never the one its turn carries.
    expect(label("trigger", { triggerName: "Acme emails" })).toBe("one of your triggers");
    const named = (name: string) => deskLabel({ trigger: "trigger", context: {} }, name);
    expect(named("Acme emails")).toBe("your trigger “Acme emails”");
    expect(named("x".repeat(80))).toHaveLength("your trigger “”".length + 40);
    expect(label("trigger")).toBe("one of your triggers");
    expect(label("slack_member")).toBe("a message in Slack");
    expect(label("something_new")).toBe("something");
  });

  it("judges health as system.status does, the worst of each group, leaving Slack's bot out", () => {
    const now = new Date("2026-10-27T12:00:00Z");
    const at = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString();
    const r = (name: string, status: "ok" | "degraded" | "failing", minsAgo = 0) => ({
      name,
      record: { status, detail: "", at: at(minsAgo) },
    });
    expect(
      liteHealth(
        [
          r("worker", "ok", 10), // stopped reporting: failing
          r("jarvis", "ok"),
          r("sync.google", "ok"),
          r("sync.slack", "degraded"),
          r("sync.slack_bot", "failing"),
          r("disk", "ok"),
        ],
        now,
      ),
    ).toEqual({ worker: "failing", jarvis: "ok", sync: "degraded", other: "ok" });
    expect(liteHealth([r("sync.slack_bot", "failing")], now).sync).toBe("unknown");
  });
});
