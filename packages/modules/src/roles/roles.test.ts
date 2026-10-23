// Pip's jobs as actions (Spec 3): you make, change, fill and remove them; Pip can make one and
// tighten one, but only you can loosen one or take something out of it; outside content can't set
// one up; and What Pip did can show one job's turns alone.
import { jarvisTurn } from "@hearth/db";
import { type Caller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Timeline } from "../activity/index.ts";
import { ALL_MODULES } from "../index.ts";
import type { RoleList, RoleView } from "./index.ts";

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterAll(() => t.destroy());

const owner = ownerCaller();
const pip = jarvisCaller("owner");
const call = <T>(name: string, input: unknown, caller: Caller = owner) =>
  t.kernel.execute<T>(name, input, caller);
async function ok<T>(name: string, input: unknown, caller: Caller = owner): Promise<T> {
  const res = await call<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

describe("Pip's jobs", () => {
  it("come with Research, which only reads and has nothing in it yet", async () => {
    const list = await ok<RoleList>("role.list", {});
    expect(list.roles).toMatchObject([
      { name: "Research", riskCeiling: "read", active: true, routines: [], reflexes: [] },
    ]);
    // What Pip does on its own can be put in a job; nothing it does only when asked can.
    expect(list.reflexes.length).toBeGreaterThan(0);
    expect(list.reflexes.map((r) => r.name)).not.toContain("routine.due");
  });

  it("are made, filled, changed and removed, and a routine survives its job", async () => {
    const job = await ok<RoleView>("role.create", {
      name: "Inbox",
      riskCeiling: "outward",
      turnsPerDay: 5,
    });
    expect(job).toMatchObject({ name: "Inbox", turnsPerDay: 5, turnsToday: 0 });
    expect(await call("role.create", { name: "inbox" })).toMatchObject({
      status: "error",
      code: "conflict",
    });
    const routine = await ok<{ id: string }>("routine.create", {
      title: "Bills",
      instructions: "Check for bills.",
      when: { every: "day", at: "08:00" },
    });
    const reflex = (await ok<RoleList>("role.list", {})).reflexes[0]!.name;
    await ok("role.attach", { id: job.id, routineId: routine.id });
    const full = await ok<RoleView>("role.attach", { id: job.id, reflex });
    expect(full.routines).toEqual([{ id: routine.id, title: "Bills" }]);
    expect(full.reflexes.map((r) => r.name)).toEqual([reflex]);
    expect(await call("role.attach", { id: job.id, reflex: "routine.due" })).toMatchObject({
      status: "error",
      code: "not_found",
    });
    const changed = await ok<RoleView>("role.update", {
      id: job.id,
      name: "Mail",
      personaNote: "Short replies.",
      turnsPerDay: null,
    });
    expect(changed).toMatchObject({
      name: "Mail",
      personaNote: "Short replies.",
      turnsPerDay: null,
    });
    await ok("role.detach", { id: job.id, reflex });
    await ok("role.remove", { id: job.id });
    const after = await ok<RoleList>("role.list", {});
    expect(after.roles.map((r) => r.name)).toEqual(["Research"]);
    expect(await ok<unknown[]>("routine.list", {})).toMatchObject([{ title: "Bills" }]);
  });

  it("can be made and tightened by Pip, but only you can loosen one", async () => {
    const job = await ok<RoleView>("role.create", { name: "Pip's own", turnsPerDay: 3 }, pip);
    expect(job.riskCeiling).toBe("read");
    // Tighter: fewer turns, off.
    await ok("role.update", { id: job.id, turnsPerDay: 2, active: false }, pip);
    for (const loosen of [
      { riskCeiling: "internal" },
      { turnsPerDay: 4 },
      { turnsPerDay: null },
      { active: true },
    ])
      expect(await call("role.update", { id: job.id, ...loosen }, pip)).toMatchObject({
        status: "error",
        code: "forbidden",
      });
    // Taking something out, or removing the job, isn't Pip's at all.
    expect(await call("role.remove", { id: job.id }, pip)).toMatchObject({ status: "denied" });
    // Nor moving something out of a job it's in already.
    const reflex = (await ok<RoleList>("role.list", {})).reflexes[0]!.name;
    await ok("role.attach", { id: job.id, reflex });
    const other = await ok<RoleView>("role.create", { name: "Other" });
    expect(await call("role.attach", { id: other.id, reflex }, pip)).toMatchObject({
      status: "error",
      code: "forbidden",
    });
    await ok("role.update", { id: job.id, riskCeiling: "outward", active: true });
    await ok("role.remove", { id: job.id });
    await ok("role.remove", { id: other.id });
  });

  it("can't be set up from outside content", async () => {
    const res = await call("role.create", { name: "Sneaky" }, jarvisCaller("untrusted"));
    expect(res).toMatchObject({ status: "error", code: "forbidden" });
  });
});

describe("What Pip did, for one job", () => {
  it("shows only that job's turns, and says which job each turn ran for", async () => {
    const [research] = (await ok<RoleList>("role.list", {})).roles;
    const at = new Date();
    const turn = (roleId: string | null, prompt: string) => ({
      id: newId(),
      trigger: "reflex" as const,
      mode: "proactive" as const,
      lane: "fast" as const,
      origin: "system" as const,
      prompt,
      status: "done" as const,
      roleId,
      queuedAt: at,
      finishedAt: at,
    });
    const mine = turn(research!.id, "Look it up.");
    const other = turn(null, "Something else.");
    await t.tdb.db.insert(jarvisTurn).values([mine, other]);
    const all = await ok<Timeline>("activity.timeline", {});
    const turns = new Map(all.groups.map((g) => [g.turn?.id, g.turn?.roleId]));
    expect(turns.get(mine.id)).toBe(research!.id);
    expect(turns.get(other.id)).toBeNull();
    // Only the job's turns: not the other turn, nor what Pip did outside any turn.
    const one = await ok<Timeline>("activity.timeline", { roleId: research!.id });
    expect(one.groups.map((g) => g.id)).toEqual([mine.id]);
    expect(one.waiting).toEqual([]);
    const none = await ok<Timeline>("activity.timeline", { roleId: newId() });
    expect(none.groups).toEqual([]);
  });
});
