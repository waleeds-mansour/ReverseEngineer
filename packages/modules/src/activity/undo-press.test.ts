// Pressing Undo on what Pip did without asking: only on what Pip did, only by you, only while
// what Pip did still stands, and saying what else it takes with it. Brought back after its Undo,
// a thing is Pip's work again, with its Undo good again.
import { PRINCIPAL } from "@hearth/core";
import { entity, event, notification, task } from "@hearth/db";
import { type Caller, jarvisCaller, memberCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import type { UndoView } from "./shape.ts";

let t: TestKernel;
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const pip = (turn = newId()) => jarvisCaller("agent", { correlationId: turn, turnId: turn });
const undos = () => ok<UndoView[]>("activity.undos", { since: "2026-09-30T00:00:00Z" });
const press = (ref: UndoView["ref"], caller: Caller = ownerCaller()) =>
  t.kernel.execute("activity.undo", { ref }, caller);
const record = async (id: string) =>
  (await t.tdb.db.select().from(entity).where(eq(entity.id, id)))[0]!;
const madeEvent = async (id: string) =>
  (
    await t.tdb.db
      .select({ id: event.id })
      .from(event)
      .where(and(eq(event.kind, "entity.created"), eq(event.entityId, id)))
  )[0]!.id;

describe("pressing Undo", () => {
  it("is refused for what you did, and for a note Pip didn't leave", async () => {
    const mine = await ok<{ id: string }>("task.create", { title: "Mine" });
    expect(await press({ kind: "event", id: await madeEvent(mine.id) })).toMatchObject({
      status: "error",
      code: "not_found",
    });
    const id = newId();
    await t.tdb.db.insert(notification).values({
      id,
      kind: "calendar.moved",
      title: "Moved",
      createdBy: PRINCIPAL.system,
      undo: { kind: "unaccept", eventId: newId(), before: { scope: "this" } },
    });
    expect(await press({ kind: "notification", id })).toMatchObject({ code: "not_found" });
    expect(await ok("activity.undos", { ref: { kind: "notification", id } })).toEqual([]);
    expect((await record(mine.id)).deletedAt).toBeNull();
  });

  it("is refused to a Slack member and to an outside agent", async () => {
    const made = await ok<{ id: string }>("task.create", { title: "Water the plants" }, pip());
    const [v] = await undos();
    const mcp: Caller = { principal: "mcp:test", kind: "mcp_client", origin: "agent", via: "mcp" };
    for (const caller of [memberCaller("T1", "U1"), mcp])
      expect((await press(v!.ref, caller)).status).not.toBe("ok");
    expect((await record(made.id)).deletedAt).toBeNull();
  });

  it("doesn't put back a memory that's had another version since", async () => {
    const m = await ok<{ id: string }>("memory.remember", { title: "Coffee", body: "Black" });
    await ok("memory.update", { id: m.id, body: "With oat milk" }, pip());
    await ok("memory.update", { id: m.id, body: "With oat milk, no sugar" }, pip());
    const [latest, first] = await undos();
    expect(latest).toMatchObject({ blocked: null });
    expect(first).toMatchObject({ blocked: "It's changed since" });
    expect(await press(first!.ref)).toMatchObject({ code: "conflict" });
    expect((await record(m.id)).body).toBe("With oat milk, no sugar");
  });

  it("puts back the field Pip changed on a task, though you've changed another since", async () => {
    const mine = await ok<{ id: string }>("task.create", { title: "Pay rent" });
    await ok("task.update", { id: mine.id, status: "completed" }, pip());
    await ok("task.update", { id: mine.id, dueAt: "2026-10-12T16:00:00.000Z" });
    const [v] = await undos();
    expect(v).toMatchObject({ did: "Marked done: Pay rent", blocked: null });
    await ok("activity.undo", { ref: v!.ref });
    const [row] = await t.tdb.db.select().from(task).where(eq(task.entityId, mine.id));
    expect(row).toMatchObject({ status: "not_started" });
    expect(row!.dueAt).toEqual(new Date("2026-10-12T16:00:00.000Z"));
  });

  it("puts back a due date as a whole day, and says the time when only the time changed", async () => {
    const mine = await ok<{ id: string }>("task.create", {
      title: "Taxes",
      dueAt: "2026-10-09T04:00:00.000Z",
      dueIsDate: true,
    });
    await ok(
      "task.update",
      { id: mine.id, dueAt: "2026-10-09T16:00:00.000Z", dueIsDate: false },
      pip(),
    );
    const [v] = await undos();
    expect(v!.did).toMatch(/^Set the due date to Fri 2026-10-09, \d+ (a|p)\.m\.: Taxes$/);
    expect(v!.label).toBe('Undo: put "Taxes" back to due Fri 2026-10-09');
    await ok("activity.undo", { ref: v!.ref });
    const [row] = await t.tdb.db.select().from(task).where(eq(task.entityId, mine.id));
    expect(row).toMatchObject({ dueIsDate: true });
    expect(row!.dueAt).toEqual(new Date("2026-10-09T04:00:00.000Z"));
  });
});

describe("Undo of what Pip made", () => {
  it("says what you added under it, which goes to the trash with it", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Trip" }, pip());
    await ok("task.create", { title: "Pack", parentId: note.id });
    await ok("task.create", { title: "Tickets", parentId: note.id });
    await ok("task.create", { title: "Pip's own", parentId: note.id }, pip());
    const v = (await undos()).find((u) => u.entityId === note.id)!;
    expect(v.label).toBe('Undo: move "Trip" to the trash, with the 2 things you added under it');
  });

  it("is good again once you bring it back from the trash, until you change it", async () => {
    const made = await ok<{ id: string }>("task.create", { title: "Call the plumber" }, pip());
    const [v] = await undos();
    const later = () => t.clock.advance(60_000);
    later();
    await ok("activity.undo", { ref: v!.ref });
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
    later();
    await ok("entity.restore", { id: made.id });
    expect((await undos())[0]).toMatchObject({ blocked: null, undone: false });
    later();
    await ok("activity.undo", { ref: v!.ref });
    expect((await record(made.id)).deletedAt).not.toBeNull();
    later();
    await ok("entity.restore", { id: made.id });
    later();
    await ok("task.update", { id: made.id, title: "Call the plumber today" });
    expect((await undos())[0]).toMatchObject({ blocked: "You've changed it since" });
  });
});

describe("Undo of a big trash", () => {
  it("lists the record, not the hundreds that went with it", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Import" });
    const at = new Date(t.clock.now().getTime() - 1_000);
    await t.tdb.db.insert(entity).values(
      Array.from({ length: 501 }, (_, i) => ({
        id: newId(),
        type: "note",
        title: `Page ${i}`,
        parentId: note.id,
        createdAt: at,
        updatedAt: at,
        createdBy: PRINCIPAL.owner,
        updatedBy: PRINCIPAL.owner,
      })),
    );
    await ok("entity.trash", { id: note.id }, pip());
    const vs = await undos();
    expect(vs).toMatchObject([{ how: "trashed", entityId: note.id, blocked: null }]);
  });
});
