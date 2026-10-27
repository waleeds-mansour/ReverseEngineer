// Undo for what Pip did without asking (the owner, 2026-10-27): what it made goes to the trash,
// what it trashed comes back, a task or a memory goes back as it was, and the calendar's own Undo
// runs from here too. Today and What Pip did read the same list, each Undo says what it does or
// why it can't any more, only you can press it, and pressing it leaves a card of its own.
import { calendarEvent, entity, notification, task } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventView } from "../calendar/store.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { Timeline, UndoView } from "./shape.ts";
import { calendarLabel } from "./undo-words.ts";

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
/** Pip, in a turn of its own: its id is the correlation of everything the turn does. */
const pip = (turn = newId()) => jarvisCaller("agent", { correlationId: turn, turnId: turn });
const undos = () => ok<UndoView[]>("activity.undos", { since: "2026-09-30T00:00:00Z" });
const press = (v: UndoView) => t.kernel.execute("activity.undo", { ref: v.ref }, ownerCaller());
const record = async (id: string) =>
  (await t.tdb.db.select().from(entity).where(eq(entity.id, id)))[0]!;

describe("Undo for what Pip made", () => {
  it("moves it to the trash, then says so on Today and on its card, with a card of its own", async () => {
    const turn = newId();
    const made = await ok<{ id: string }>("task.create", { title: "Call the plumber" }, pip(turn));
    const [v] = await undos();
    expect(v).toMatchObject({
      groupId: turn,
      how: "made",
      did: "Made a task: Call the plumber",
      label: 'Undo: move "Call the plumber" to the trash',
      blocked: null,
      undone: false,
      entityId: made.id,
      entityType: "task",
    });
    await ok("activity.undo", { ref: v!.ref });
    expect((await record(made.id)).deletedAt).not.toBeNull();
    const [after] = await undos();
    expect(after).toMatchObject({ blocked: "Undone", undone: true });

    const tl = await ok<Timeline>("activity.timeline", {});
    expect(tl.groups.find((g) => g.id === turn)?.undos).toEqual([after]);
    expect(tl.groups.find((g) => g.undid)?.undid).toEqual({
      did: "Made a task: Call the plumber",
      entityId: made.id,
      entityType: "task",
      outside: false,
    });
    expect(await press(v!)).toMatchObject({
      status: "error",
      message: "You've undone this already.",
    });
  });

  it("is greyed once you've changed it, and refused if pressed", async () => {
    const made = await ok<{ id: string }>("task.create", { title: "Book the car" }, pip());
    await ok("task.update", { id: made.id, title: "Book the car service" });
    const [v] = await undos();
    expect(v).toMatchObject({ blocked: "You've changed it since", undone: false });
    expect(await press(v!)).toMatchObject({ status: "error", code: "conflict" });
    expect((await record(made.id)).deletedAt).toBeNull();
  });

  it("is too old after a week", async () => {
    await ok("task.create", { title: "Old errand" }, pip());
    t.clock.advance(8 * 86_400_000);
    const [v] = await undos();
    expect(v?.blocked).toBe("Too old to undo here");
  });

  it("lists only what Pip did: not yours, and not the conversations that log its turns", async () => {
    await ok("task.create", { title: "Mine" });
    await ok("conversation.create", { title: "Pip heartbeat" }, pip());
    expect(await undos()).toEqual([]);
  });

  it("is yours alone to press", async () => {
    await ok("task.create", { title: "Water the plants" }, pip());
    const [v] = await undos();
    const res = await t.kernel.execute("activity.undo", { ref: v!.ref }, pip());
    expect(res.status).toBe("denied");
  });
});

describe("Undo for what Pip moved to the trash", () => {
  it("brings it back with what went with it, which has no Undo of its own", async () => {
    const note = await ok<{ id: string }>("note.create", { title: "Trip" });
    const sub = await ok<{ id: string }>("task.create", { title: "Pack", parentId: note.id });
    await ok("entity.trash", { id: note.id }, pip());
    const vs = await undos();
    expect(vs).toMatchObject([
      {
        how: "trashed",
        entityId: note.id,
        did: "Moved to the trash: Trip",
        label: 'Undo: bring "Trip" back from the trash',
        blocked: null,
      },
    ]);
    await ok("activity.undo", { ref: vs[0]!.ref });
    expect((await record(note.id)).deletedAt).toBeNull();
    expect((await record(sub.id)).deletedAt).toBeNull();
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });
});

describe("Undo for a task Pip changed", () => {
  it("puts its status and due date back, each on its own, unless you've changed it since", async () => {
    const mine = await ok<{ id: string }>("task.create", {
      title: "Pay rent",
      dueAt: "2026-10-05T16:00:00.000Z",
    });
    await ok(
      "task.update",
      { id: mine.id, status: "completed", dueAt: "2026-10-09T16:00:00.000Z" },
      pip(),
    );
    const vs = await undos();
    const status = vs.find((v) => v.did.startsWith("Marked"))!;
    const due = vs.find((v) => v.did.startsWith("Set the due date"))!;
    expect(status).toMatchObject({
      did: "Marked done: Pay rent",
      label: 'Undo: put "Pay rent" back to not started',
      blocked: null,
    });
    expect(due).toMatchObject({
      did: "Set the due date to Fri 2026-10-09: Pay rent",
      label: 'Undo: put "Pay rent" back to due Mon 2026-10-05',
      blocked: null,
    });
    await ok("activity.undo", { ref: status.ref });
    const [row] = await t.tdb.db.select().from(task).where(eq(task.entityId, mine.id));
    expect(row).toMatchObject({ status: "not_started", completedAt: null });
    expect(row!.dueAt).toEqual(new Date("2026-10-09T16:00:00.000Z"));

    await ok("task.update", { id: mine.id, dueAt: "2026-10-12T16:00:00.000Z" });
    const now = await undos();
    expect(now.find((v) => v.ref.id === due.ref.id)).toMatchObject({
      blocked: "You've changed it since",
    });
    expect(now.find((v) => v.ref.id === status.ref.id)).toMatchObject({ blocked: "Undone" });
  });

  it("leaves a task Pip made whole: its fields go with the task's own Undo", async () => {
    await ok("task.create", { title: "Plan", dueAt: "2026-10-05T16:00:00.000Z" }, pip());
    expect((await undos()).map((v) => v.how)).toEqual(["made"]);
  });
});

describe("Undo for a memory Pip rewrote", () => {
  it("puts back the version before", async () => {
    const m = await ok<{ id: string }>("memory.remember", { title: "Coffee", body: "Black" });
    await ok("memory.update", { id: m.id, body: "With oat milk" }, pip());
    const [v] = await undos();
    expect(v).toMatchObject({
      how: "changed",
      did: "Changed what it remembers: Coffee",
      blocked: null,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect((await record(m.id)).body).toBe("Black");
    expect((await undos())[0]).toMatchObject({ blocked: "Undone" });
  });
});

describe("the calendar's own Undo, from here", () => {
  const ME = "owner@example.com";
  let g: FakeGoogle;
  beforeEach(async () => {
    g = new FakeGoogle(ME);
    g.clock = t.clock;
    t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
    const client = g.client(t.tdb.db);
    const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
    await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
    await ok("calendar.sync", {}, integrationCaller("google"));
  });

  it("moves your event back, clears the note's Undo and says it's undone", async () => {
    const ev = await ok<EventView>("calendar.create_event", {
      title: "Dentist",
      start: "2026-10-06T14:00:00Z",
      end: "2026-10-06T15:00:00Z",
    });
    const turn = newId();
    await ok(
      "calendar.update_event",
      { id: ev.id, start: "2026-10-07T18:00:00Z", end: "2026-10-07T19:00:00Z" },
      jarvisCaller("untrusted", { correlationId: turn, mode: "proactive" }),
    );
    const v = (await undos()).find((u) => u.ref.kind === "notification")!;
    expect(v).toMatchObject({
      groupId: turn,
      did: 'Moved "Dentist" to Wed 2026-10-07, 2 p.m.',
      label: 'Undo: move "Dentist" back to Tue 2026-10-06, 10 a.m.',
      entityId: ev.id,
      entityType: "event",
      outside: true,
      blocked: null,
    });
    await ok("activity.undo", { ref: v.ref });
    const [back] = await t.tdb.db
      .select()
      .from(calendarEvent)
      .where(eq(calendarEvent.entityId, ev.id));
    expect(back!.startsAt).toEqual(new Date("2026-10-06T14:00:00Z"));
    const [n] = await t.tdb.db.select().from(notification).where(eq(notification.id, v.ref.id));
    expect(n!.undo).toBeNull();
    expect((await undos()).find((u) => u.ref.id === v.ref.id)).toMatchObject({
      blocked: "Undone",
      undone: true,
    });
  });
});

describe("the calendar's words", () => {
  it("say that taking back a yes is seen by the organizer", () => {
    expect(
      calendarLabel({ kind: "unaccept", eventId: newId(), before: { scope: "this" } }, "Standup"),
    ).toBe('Undo: take back the yes to "Standup"; its organizer will see');
  });
});
