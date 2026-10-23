// Spec 5: while background work is read-only, a proactive turn's calls only read and keep notes.
// The rest is refused, never asked, so nothing wakes you; your own turns are as they were.
import { approval, audit } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { jarvisCaller } from "./callers.ts";
import { holdsFor } from "./guard.ts";
import { BACKGROUND_READ_ONLY, decide, HELD_FOR_BRIEF } from "./policy.ts";
import { setSetting } from "./settings.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { type ActionDef, defineAction, defineModule } from "./types.ts";

const sent: string[] = [];

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
      name: "probe.look",
      description: "Reads something",
      input: z.object({}),
      risk: "read",
      handler: async () => ({ seen: true }),
    }),
    defineAction({
      name: "probe.note",
      description: "Keeps a note in Nook",
      input: z.object({}),
      risk: "internal",
      handler: async () => ({ noted: true }),
    }),
    defineAction({
      name: "probe.label",
      description: "Changes your own account",
      input: z.object({}),
      risk: "self_external",
      handler: async () => ({ labeled: true }),
    }),
    defineAction({
      name: "probe.send",
      description: "Sends something to someone",
      input: z.object({ to: z.string() }),
      risk: "outward",
      summarize: (i) => `Send to ${i.to}`,
      async handler(i) {
        sent.push(i.to);
        return { sent: true };
      },
    }),
  ],
});

const proactive = jarvisCaller("system", { mode: "proactive" });
const reactive = jarvisCaller("owner", { mode: "reactive" });

describe("decide, for background work", () => {
  const def = (risk: ActionDef["risk"]) => ({ risk });
  const on = [BACKGROUND_READ_ONLY];

  it("refuses a proactive turn anything above reads and notes while it's read-only", () => {
    for (const risk of ["self_external", "outward", "destructive"] as const)
      expect(decide(def(risk), proactive, false, on)).toEqual({
        kind: "deny",
        reason: HELD_FOR_BRIEF,
      });
    expect(decide(def("read"), proactive, false, on)).toEqual({ kind: "allow" });
    expect(decide(def("internal"), proactive, false, on)).toEqual({ kind: "allow" });
  });

  it("refuses rather than asks, even where a standing rule or askFirst would apply", () => {
    expect(decide(def("outward"), proactive, true, on).kind).toBe("deny");
    const asking = { ...proactive, askFirst: "Only outside content showed it this address." };
    expect(decide(def("read"), asking, false, on)).toEqual({
      kind: "deny",
      reason: HELD_FOR_BRIEF,
    });
  });

  it("asks as before with no hold", () => {
    expect(decide(def("outward"), proactive, false).kind).toBe("ask");
    expect(decide(def("self_external"), proactive, false).kind).toBe("allow");
  });
});

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel([probe]);
});
afterAll(() => t.destroy());
beforeEach(() => {
  sent.length = 0;
});
const approvals = () => t.tdb.db.select().from(approval);

describe("background work while read-only", () => {
  it("refuses a proactive turn's outward call without asking, and audits it", async () => {
    await setSetting(t.kernel.db, "jarvis.backgroundReadOnly", true);
    const before = (await approvals()).length;
    const res = await t.kernel.execute("probe.send", { to: "Ana" }, proactive);
    expect(res).toEqual({ status: "denied", reason: HELD_FOR_BRIEF });
    expect(sent).toEqual([]);
    expect(await approvals()).toHaveLength(before);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "probe.send"));
    expect(rows).toMatchObject([{ outcome: "denied", error: HELD_FOR_BRIEF, principal: "jarvis" }]);
    // Reads and notes still run; changing your own account doesn't.
    expect((await t.kernel.execute("probe.look", {}, proactive)).status).toBe("ok");
    expect((await t.kernel.execute("probe.note", {}, proactive)).status).toBe("ok");
    expect(await t.kernel.execute("probe.label", {}, proactive)).toEqual({
      status: "denied",
      reason: HELD_FOR_BRIEF,
    });
  });

  it("asks for the same call when it's off", async () => {
    await setSetting(t.kernel.db, "jarvis.backgroundReadOnly", false);
    const res = await t.kernel.execute("probe.send", { to: "Ana" }, proactive);
    expect(res).toMatchObject({ status: "pending_approval", summary: "Send to Ana" });
    expect((await t.kernel.execute("probe.label", {}, proactive)).status).toBe("ok");
  });

  it("holds only a proactive turn of Pip's: never your own turns or a call without a mode", async () => {
    await setSetting(t.kernel.db, "jarvis.backgroundReadOnly", true);
    expect(await holdsFor(t.kernel.db, proactive)).toEqual([BACKGROUND_READ_ONLY]);
    expect(await holdsFor(t.kernel.db, reactive)).toEqual([]);
    // A call made as Pip without a turn (a reflex, a self-test) has no mode.
    expect(await holdsFor(t.kernel.db, jarvisCaller("system"))).toEqual([]);
    await setSetting(t.kernel.db, "jarvis.backgroundReadOnly", false);
    expect(await holdsFor(t.kernel.db, proactive)).toEqual([]);
  });

  it("leaves your own turns as they were, either way", async () => {
    for (const on of [true, false]) {
      await setSetting(t.kernel.db, "jarvis.backgroundReadOnly", on);
      const res = await t.kernel.execute("probe.send", { to: `Ana ${on}` }, reactive);
      expect(res).toMatchObject({ status: "pending_approval", summary: `Send to Ana ${on}` });
      expect((await t.kernel.execute("probe.label", {}, reactive)).status).toBe("ok");
    }
  });
});
