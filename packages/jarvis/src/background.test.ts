// Spec 5 in a real turn: background work while read-only gets its outward call refused, not
// asked, and the turn notes it once for your brief; so does a proactive reflex's act. Your own
// turns are as they were.
import { approval, observation } from "@hearth/db";
import {
  defineAction,
  defineModule,
  HELD_FOR_BRIEF,
  ownerCaller,
  setSetting,
} from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

const probe = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: [],
  events: [{ kind: "probe.poked", description: "Something to reach out about" }],
  knowledge: {},
  reflexes: [
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

const sends = () => h.tdb.db.select().from(approval).where(eq(approval.action, "probe.send"));
const held = () => h.tdb.db.select().from(observation);

/** The morning brief's turn (proactive) tries to send twice; returns what it was told. */
async function briefTurnSends(): Promise<{ system: string; outputs: string[] }> {
  const seen = { system: "", outputs: [] as string[] };
  h.brain.next((req, out) => {
    seen.system = req.system;
    seen.outputs = out;
    return [
      { call: "probe_send", input: { to: "Ana" } },
      { call: "probe_send", input: { to: "Ana" } },
      { say: "" },
    ];
  });
  h.clock.set("2026-10-02T12:15:10Z"); // Friday 8:15 a.m.
  await h.settle();
  return seen;
}

describe("Pip's background work while read-only", () => {
  it("refuses a proactive turn's outward call, and notes it once for the brief", async () => {
    await setSetting(h.tdb.db, "jarvis.backgroundReadOnly", true);
    const { system, outputs } = await briefTurnSends();
    expect(system).toContain("Background work is read-only");
    expect(outputs[0]).toBe(`Not allowed: ${HELD_FOR_BRIEF}`);
    expect(outputs[1]).toBe(`Not allowed: ${HELD_FOR_BRIEF}`);
    expect(await sends()).toEqual([]);
    expect(await held()).toMatchObject([
      {
        kind: "followup",
        text: "Held while background work was read-only: Send to Ana",
        createdBy: "jarvis",
      },
    ]);
  });

  it("asks for the same call when it's off", async () => {
    const { system, outputs } = await briefTurnSends();
    expect(system).not.toContain("read-only");
    expect(outputs[0]).toMatch(/^Waiting for the owner's approval/);
    expect(await sends()).toHaveLength(1);
    expect(await held()).toEqual([]);
  });

  it("refuses a proactive reflex's outward act too, and notes it", async () => {
    for (const on of [true, false]) {
      await setSetting(h.tdb.db, "jarvis.backgroundReadOnly", on);
      await h.kernel.execute("probe.poke", {}, ownerCaller());
      await h.settle();
    }
    // Off, it asked as before; on, it was held without a card.
    expect(await sends()).toHaveLength(1);
    expect(await held()).toMatchObject([
      { text: "Held while background work was read-only: Send to Bo" },
    ]);
  });

  it("leaves your own turns as they were", async () => {
    await setSetting(h.tdb.db, "jarvis.backgroundReadOnly", true);
    let system = "";
    let outputs: string[] = [];
    h.brain.next((req, out) => {
      system = req.system;
      outputs = out;
      return [{ call: "probe_send", input: { to: "Ana" } }, { say: "Asked." }];
    });
    await h.kernel.execute("chat.send", { text: "send Ana the notes" }, ownerCaller());
    await h.settle();
    expect(system).not.toContain("read-only");
    expect(outputs[0]).toMatch(/^Waiting for the owner's approval/);
    expect(await sends()).toHaveLength(1);
    expect(await held()).toEqual([]);
  });
});
