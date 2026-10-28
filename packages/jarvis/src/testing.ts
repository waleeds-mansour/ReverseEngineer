// A harness that runs the whole spine (scheduler, reflex engine, turn runner) against a test
// database with a scripted brain and a manual clock.
import { entity } from "@hearth/db";
import { defineAction, defineModule, type HearthModule, runDueSchedules } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { ALL_MODULES } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Brain } from "./brain.ts";
import { ScriptedBrain } from "./brains/scripted.ts";
import { ReflexEngine } from "./engine.ts";
import { type RunnerOptions, TurnRunner } from "./runner.ts";
import { registerRoutines } from "./service.ts";

/**
 * Something hard to undo that isn't the trash, for tests of what still waits for your yes: Pip
 * trashes on its own since 2026-10-27. Its tool is probe_purge; here it only hides the record.
 */
export const purgeModule = defineModule({
  name: "probe",
  description: "Test module",
  entityTypes: [],
  events: [],
  knowledge: {},
  reflexes: [],
  noReflexesBecause: "test module",
  actions: [
    defineAction({
      name: "probe.purge",
      description: "Delete a record for good.",
      input: z.object({ id: z.string() }),
      risk: "destructive",
      summarize: (i) => `Delete ${i.id} for good`,
      async handler(i, ctx) {
        await ctx.tx.update(entity).set({ deletedAt: ctx.now }).where(eq(entity.id, i.id));
        return { purged: i.id };
      },
    }),
  ],
});

export interface JarvisHarness extends TestKernel {
  brain: ScriptedBrain;
  engine: ReflexEngine;
  runner: TurnRunner;
  logs: string[];
  /** Fires due schedules, runs reflexes and turns until nothing is left to do. */
  settle(): Promise<{ fired: number; events: number; turns: number }>;
}

export async function createJarvisHarness(
  start?: string,
  opts: {
    brain?: Brain;
    runner?: Pick<RunnerOptions, "limits" | "turnLog" | "stopCheckMs" | "nextReplies">;
    /** Test modules to load beside Hearth's own. */
    modules?: HearthModule[];
  } = {},
): Promise<JarvisHarness> {
  const t = await createTestKernel([...ALL_MODULES, ...(opts.modules ?? [])], start);
  const logs: string[] = [];
  const log = (m: string, e?: unknown) =>
    logs.push(`${m}${e ? ` ${e instanceof Error ? e.message : JSON.stringify(e)}` : ""}`);
  const brain = new ScriptedBrain();
  const engine = new ReflexEngine({ kernel: t.kernel, log });
  const runner = new TurnRunner({
    kernel: t.kernel,
    brain: opts.brain ?? brain,
    log,
    ...opts.runner,
  });
  await registerRoutines(t.kernel);
  return {
    ...t,
    brain,
    engine,
    runner,
    logs,
    async settle() {
      const total = { fired: 0, events: 0, turns: 0 };
      for (let i = 0; i < 25; i++) {
        const fired = await runDueSchedules(t.kernel.db, t.clock);
        const events = await engine.processAvailable();
        const turns = await runner.drain();
        // Ready replies are made after a turn, in the background (D85).
        await runner.offers?.idle();
        total.fired += fired;
        total.events += events;
        total.turns += turns;
        if (fired + events + turns === 0) return total;
      }
      throw new Error("Jarvis never settled (a loop?)");
    },
  };
}
