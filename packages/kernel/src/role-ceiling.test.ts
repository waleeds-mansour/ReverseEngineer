// Spec 3: a job's ceiling, held at the same chokepoint as Spec 5's read-only. A call of Pip's that
// reaches past the job it runs for is refused, never asked, and its reason says it's held for your
// brief; what only reports (a note, a card) stays within any ceiling.
import { approval, audit, role } from "@hearth/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { jarvisCaller, ownerCaller } from "./callers.ts";
import { holdsFor } from "./guard.ts";
import { newId } from "./ids.ts";
import { BACKGROUND_READ_ONLY, decide, HELD_FOR_BRIEF, isHeldReason, roleHold } from "./policy.ts";
import { setSetting } from "./settings.ts";
import { createTestKernel, type TestKernel } from "./testing.ts";
import { type ActionDef, defineAction, defineModule } from "./types.ts";

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
      name: "probe.tell",
      description: "Tells the owner something",
      input: z.object({}),
      risk: "internal",
      reports: true,
      handler: async () => ({ told: true }),
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

const def = (risk: ActionDef["risk"], reports = false) => ({
  risk,
  ...(reports ? { reports } : {}),
});

describe("decide, under a job's ceiling", () => {
  const pip = jarvisCaller("owner", { mode: "reactive" });

  it("holds what reaches past the ceiling, and lets the rest through as usual", () => {
    const research = [roleHold("Research", "read")];
    expect(decide(def("read"), pip, false, research)).toEqual({ kind: "allow" });
    for (const risk of ["internal", "self_external", "outward", "destructive"] as const) {
      const d = decide(def(risk), pip, false, research);
      expect(d).toEqual({
        kind: "deny",
        reason: "Pip's Research job only reads, so this was held for your brief.",
      });
    }
    const inbox = [roleHold("Inbox", "outward")];
    // Within the ceiling, an outward call still asks, and a standing rule still lets it through.
    expect(decide(def("outward"), pip, false, inbox).kind).toBe("ask");
    expect(decide(def("outward"), pip, true, inbox).kind).toBe("allow");
    expect(decide(def("destructive"), pip, true, inbox).kind).toBe("deny");
  });

  it("refuses rather than asks, even with a standing rule", () => {
    const d = decide(def("outward"), pip, true, [roleHold("Research", "internal")]);
    expect(d.kind).toBe("deny");
  });

  it("lets a report through any ceiling, and never lets one widen a caller's kind", () => {
    expect(decide(def("internal", true), pip, false, [roleHold("Research", "read")])).toEqual({
      kind: "allow",
    });
    // Secrets stay refused for Pip whatever the job.
    expect(decide(def("secret"), pip, false, [roleHold("All", "outward")]).kind).toBe("deny");
  });

  it("says every hold the same way, so a turn and What Pip did can tell", () => {
    expect(isHeldReason(HELD_FOR_BRIEF)).toBe(true);
    expect(isHeldReason(roleHold("Research", "read").reason)).toBe(true);
    expect(isHeldReason("Only owner may do this.")).toBe(false);
    expect(isHeldReason(null)).toBe(false);
  });
});

let t: TestKernel;
let research: string;
beforeAll(async () => {
  t = await createTestKernel([probe]);
  research = newId();
  await t.tdb.db.insert(role).values({ id: research, name: "Scout", riskCeiling: "read" });
});
afterAll(() => t.destroy());

describe("a job's ceiling in the kernel", () => {
  it("reads the job's ceiling for every call of Pip's that runs for it", async () => {
    const caller = jarvisCaller("owner", { mode: "reactive", roleId: research });
    expect(await holdsFor(t.kernel.db, caller)).toEqual([roleHold("Scout", "read")]);
    // Proactive while background is read-only: both hold, the stricter first to match.
    await setSetting(t.kernel.db, "jarvis.backgroundReadOnly", true);
    expect(await holdsFor(t.kernel.db, { ...caller, mode: "proactive" })).toEqual([
      BACKGROUND_READ_ONLY,
      roleHold("Scout", "read"),
    ]);
    await setSetting(t.kernel.db, "jarvis.backgroundReadOnly", false);
    // Only Pip's calls: yours never run for a job.
    expect(await holdsFor(t.kernel.db, ownerCaller("ui", { roleId: research }))).toEqual([]);
    // A job that's gone holds nothing: removing it was yours.
    expect(await holdsFor(t.kernel.db, { ...caller, roleId: newId() })).toEqual([]);
  });

  it("refuses a call past it without asking, audits it, and lets reports through", async () => {
    const caller = jarvisCaller("owner", { mode: "reactive", roleId: research });
    const reason = "Pip's Scout job only reads, so this was held for your brief.";
    expect(await t.kernel.execute("probe.send", { to: "Ana" }, caller)).toEqual({
      status: "denied",
      reason,
    });
    expect(await t.kernel.execute("probe.note", {}, caller)).toEqual({ status: "denied", reason });
    expect((await t.kernel.execute("probe.look", {}, caller)).status).toBe("ok");
    expect((await t.kernel.execute("probe.tell", {}, caller)).status).toBe("ok");
    expect(await t.tdb.db.select().from(approval)).toEqual([]);
    const rows = await t.tdb.db.select().from(audit).where(eq(audit.action, "probe.send"));
    expect(rows).toMatchObject([{ outcome: "denied", error: reason, principal: "jarvis" }]);
  });

  it("applies a change to the ceiling at once", async () => {
    const caller = jarvisCaller("owner", { mode: "reactive", roleId: research });
    await t.tdb.db.update(role).set({ riskCeiling: "internal" }).where(eq(role.id, research));
    expect((await t.kernel.execute("probe.note", {}, caller)).status).toBe("ok");
    await t.tdb.db.update(role).set({ riskCeiling: "outward" }).where(eq(role.id, research));
    expect(await t.kernel.execute("probe.send", { to: "Bo" }, caller)).toMatchObject({
      status: "pending_approval",
      summary: "Send to Bo",
    });
  });
});
