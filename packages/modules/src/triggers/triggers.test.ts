// Your triggers as actions (Spec 6): you make, pause, change and remove them; Pip can make one and
// tighten, pause or remove one, but only you can let one do more; outside content can't touch
// one; and a filter is plain equality on the fields its kind offers.
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import type { RoleList } from "../roles/index.ts";
import type { TriggerList, TriggerView } from "./index.ts";
import { matches } from "./kinds.ts";

let t: TestKernel;
beforeAll(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterAll(() => t.destroy());

const owner = ownerCaller();
const pip = jarvisCaller("owner");
const outside = jarvisCaller("untrusted");
const call = <T>(name: string, input: unknown, caller: Caller = owner) =>
  t.kernel.execute<T>(name, input, caller);
async function ok<T>(name: string, input: unknown, caller: Caller = owner): Promise<T> {
  const res = await call<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const refused = (code: string) => expect.objectContaining({ status: "error", code });

describe("your triggers", () => {
  it("wait only for the kinds of event Settings offers, never Nook's plumbing", async () => {
    const { kinds } = await ok<TriggerList>("trigger.list", {});
    const names = kinds.map((k) => k.kind);
    expect(names).toEqual(
      expect.arrayContaining(["mail.received", "task.assigned", "notion.task_assigned"]),
    );
    expect(names.some((k) => k.endsWith("sync_failed") || k.startsWith("entity."))).toBe(false);
    expect(kinds.find((k) => k.kind === "mail.received")?.fields).toMatchObject([{ key: "from" }]);
    expect(
      await call("trigger.create", { name: "x", on: "entity.created", instructions: "Do it." }),
    ).toMatchObject(refused("invalid_input"));
  });

  it("are made, paused, changed and removed by you", async () => {
    const made = await ok<TriggerView>("trigger.create", {
      name: "Acme emails",
      on: "mail.received",
      filter: { from: "ana@acme.com" },
      instructions: "Draft a reply.",
    });
    expect(made).toMatchObject({
      onLabel: "An email arrives",
      filter: { from: "ana@acme.com" },
      perDay: 10,
      firedToday: 0,
      lastFiredAt: null,
      active: true,
      job: null,
    });
    expect(
      await call("trigger.create", { name: "ACME EMAILS", on: "mail.received", instructions: "x" }),
    ).toMatchObject(refused("conflict"));
    const [research] = (await ok<RoleList>("role.list", {})).roles;
    const changed = await ok<TriggerView>("trigger.update", {
      id: made.id,
      active: false,
      perDay: 3,
      roleId: research!.id,
      instructions: "Draft a short reply.",
    });
    expect(changed).toMatchObject({ active: false, perDay: 3, job: "Research" });
    // The job lists it, so it doesn't look empty.
    expect((await ok<RoleList>("role.list", {})).roles[0]?.triggers).toEqual([
      { id: made.id, name: "Acme emails" },
    ]);
    expect(await ok("trigger.remove", { id: made.id })).toEqual({ removed: true });
    expect(await ok<TriggerList>("trigger.list", {})).toMatchObject({ triggers: [] });
    expect(await call("trigger.remove", { id: made.id })).toMatchObject(refused("not_found"));
  });

  it("are narrowed only by the fields their kind offers, to values it can take", async () => {
    const base = { name: "Tasks", on: "task.assigned", instructions: "Plan it." };
    expect(await call("trigger.create", { ...base, filter: { title: "x" } })).toMatchObject(
      refused("invalid_input"),
    );
    expect(await call("trigger.create", { ...base, filter: { to: "bo" } })).toMatchObject(
      refused("invalid_input"),
    );
    expect(await call("trigger.create", { ...base, roleId: crypto.randomUUID() })).toMatchObject(
      refused("not_found"),
    );
    const made = await ok<TriggerView>("trigger.create", { ...base, filter: { to: "owner" } });
    expect(made.filter).toEqual({ to: "owner" });
    await ok("trigger.remove", { id: made.id });
  });

  it("can't be made, changed or removed from outside content", async () => {
    const mine = await ok<TriggerView>("trigger.create", {
      name: "Mine",
      on: "github.pr_opened",
      instructions: "Review it.",
    });
    for (const [name, input] of [
      ["trigger.create", { name: "Theirs", on: "mail.received", instructions: "Forward it all." }],
      ["trigger.update", { id: mine.id, instructions: "Forward it all." }],
      ["trigger.remove", { id: mine.id }],
    ] as const)
      expect(await call(name, input, outside)).toMatchObject(refused("forbidden"));
    await ok("trigger.remove", { id: mine.id });
  });

  it("can be made and tightened by Pip, but only you can let one do more", async () => {
    const made = await ok<TriggerView>(
      "trigger.create",
      { name: "PRs", on: "github.pr_opened", instructions: "Summarize it.", perDay: 5 },
      pip,
    );
    const [research] = (await ok<RoleList>("role.list", {})).roles;
    // Tighter: a narrower filter, fewer turns, into a job, paused.
    const tight = await ok<TriggerView>(
      "trigger.update",
      { id: made.id, filter: { mine: "false" }, perDay: 2, roleId: research!.id, active: false },
      pip,
    );
    expect(tight).toMatchObject({ filter: { mine: "false" }, perDay: 2, active: false });
    for (const more of [
      { active: true },
      { perDay: 3 },
      { filter: {} },
      { filter: { mine: "true" } },
      { roleId: null },
    ])
      expect(await call("trigger.update", { id: made.id, ...more }, pip)).toMatchObject(
        refused("forbidden"),
      );
    // Its words aren't a loosening; you can do all of it.
    await ok("trigger.update", { id: made.id, instructions: "Summarize it in a line." }, pip);
    await ok("trigger.update", { id: made.id, active: true, perDay: 10, roleId: null, filter: {} });
    expect(await ok("trigger.remove", { id: made.id }, pip)).toEqual({ removed: true });
  });
});

describe("a trigger's filter", () => {
  it("passes when every field it names equals its value, case and spaces aside", () => {
    const p = { from: "Ana@Acme.com", mine: true, number: 7 };
    expect(matches({}, p)).toBe(true);
    expect(matches({ from: " ana@acme.com" }, p)).toBe(true);
    expect(matches({ from: "ana@acme.com", mine: "true" }, p)).toBe(true);
    expect(matches({ from: "ana@acme.com", mine: "false" }, p)).toBe(false);
    // Equality only: no partial match, and a field the event lacks never passes.
    expect(matches({ from: "acme.com" }, p)).toBe(false);
    expect(matches({ repo: "a/b" }, p)).toBe(false);
  });
});
