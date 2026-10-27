// Undo for an event Pip put on your calendar on its own (the owner, 2026-10-27): one it added or a
// task's block of time comes off again, telling nobody (sendUpdates=none), with no age limit,
// while it has no guests and is where Pip put it. Guests added since, even at Google before Nook
// has seen them, or a move by you, and it's greyed or refused.
import { calendarEvent } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockResult } from "../calendar/blocks.ts";
import type { EventView } from "../calendar/store.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { UndoView } from "./shape.ts";
import { addedPiece } from "./undo-added.ts";

const ME = "owner@example.com";
const SAM = "sam@partner.example";
let t: TestKernel;
let g: FakeGoogle;
/** Every call to Google, with its query: how Google was told to tell guests. */
let urls: string[];

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  urls = [];
  const real = g.fetch.bind(g);
  g.fetch = (url, init) => {
    urls.push(`${init?.method ?? "GET"} ${url}`);
    return real(url, init);
  };
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await ok("calendar.sync", {}, integrationCaller("google"));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const pip = () => jarvisCaller("untrusted", { correlationId: newId(), mode: "proactive" });
const undos = () => ok<UndoView[]>("activity.undos", { since: "2026-09-30T00:00:00Z" });
const press = (v: UndoView) => t.kernel.execute("activity.undo", { ref: v.ref }, ownerCaller());
const row = async (id: string) =>
  (await t.tdb.db.select().from(calendarEvent).where(eq(calendarEvent.entityId, id)))[0]!;
const deletes = () => urls.filter((u) => u.startsWith("DELETE"));

async function gymByPip() {
  const ev = await ok<EventView>(
    "calendar.create_event",
    { title: "Gym", start: "2026-10-06T22:00:00Z", end: "2026-10-06T23:00:00Z" },
    pip(),
  );
  const [v] = await undos();
  return { ev, v: v! };
}

describe("Undo for an event Pip added", () => {
  it("takes it off your calendar, telling nobody, then says it's undone", async () => {
    const { ev, v } = await gymByPip();
    expect(v).toMatchObject({
      how: "made",
      did: "Added to your calendar: Gym",
      label: 'Undo: take "Gym" off your calendar',
      tells: null,
      blocked: null,
      entityId: ev.id,
      entityType: "event",
      outside: true,
    });
    await ok("activity.undo", { ref: v.ref });
    expect((await row(ev.id)).status).toBe("cancelled");
    expect(deletes()).toHaveLength(1);
    expect(deletes()[0]).toContain("sendUpdates=none");
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });

  it("stays good past a week while it's as Pip left it", async () => {
    await gymByPip();
    t.clock.advance(30 * 86_400_000);
    expect((await undos())[0]).toMatchObject({ blocked: null });
  });

  it("is greyed and refused once you've moved it, which it leaves where you put it", async () => {
    const { ev, v } = await gymByPip();
    await ok("calendar.update_event", {
      id: ev.id,
      start: "2026-10-07T22:00:00Z",
      end: "2026-10-07T23:00:00Z",
    });
    expect((await undos())[0]).toMatchObject({ blocked: "You've changed it since" });
    expect(await press(v)).toMatchObject({ code: "conflict" });
    expect((await row(ev.id)).status).not.toBe("cancelled");
    expect(deletes()).toEqual([]);
  });

  it("is refused when it has guests at Google, before Nook has seen them, and greyed once it has", async () => {
    const { ev, v } = await gymByPip();
    const at = await row(ev.id);
    g.put(ME, {
      id: at.googleId,
      summary: "Gym",
      start: { dateTime: "2026-10-06T22:00:00Z" },
      end: { dateTime: "2026-10-06T23:00:00Z" },
      attendees: [{ email: SAM }, { email: ME, self: true }],
    });
    expect(await press(v)).toMatchObject({
      code: "conflict",
      message: "It has guests now, so taking it off would tell them.",
    });
    expect(deletes()).toEqual([]);
    await ok("calendar.sync", {}, integrationCaller("google"));
    expect((await undos())[0]).toMatchObject({
      blocked: "It has guests now, so Undo would tell them",
    });
  });

  it("has none for an event you added, or one added with guests", async () => {
    await ok("calendar.create_event", {
      title: "Dentist",
      start: "2026-10-06T14:00:00Z",
      end: "2026-10-06T15:00:00Z",
    });
    expect(await undos()).toEqual([]);
    const { ev, v } = await gymByPip();
    const e = (await t.events("calendar.event_changed")).find((x) => x.entityId === ev.id);
    const facts = {
      rows: new Map([
        [
          ev.id,
          {
            status: "confirmed",
            startsAt: ev.startsAt,
            endsAt: ev.endsAt,
            guests: 1,
            block: false,
          },
        ],
      ]),
      later: [],
    };
    const rec = {
      id: ev.id,
      type: "event",
      title: "Gym",
      deletedAt: null,
      updatedAt: new Date(),
      updatedBy: "jarvis",
      outside: true,
      parentId: null,
    };
    expect(v.entityId).toBe(ev.id);
    expect(addedPiece({ ...e!, payload: { ...e!.payload, guests: 1 } }, rec, facts)).toBeNull();
    // Added before Nook said how many guests it had, and it has some now: maybe a meeting.
    const { guests: _, ...before } = e!.payload;
    expect(addedPiece({ ...e!, payload: before }, rec, facts)).toBeNull();
  });

  it("is refused when it's been moved or renamed at Google, before Nook has seen it", async () => {
    const { ev, v } = await gymByPip();
    const at = await row(ev.id);
    const atGoogle = (summary: string, day: string) =>
      g.put(ME, {
        id: at.googleId,
        summary,
        start: { dateTime: `2026-10-${day}T22:00:00Z` },
        end: { dateTime: `2026-10-${day}T23:00:00Z` },
      });
    atGoogle("Gym", "07");
    expect(await press(v)).toMatchObject({
      code: "conflict",
      message: "It's been moved since, so Undo would undo that instead.",
    });
    atGoogle("Gym with Sam", "06");
    expect(await press(v)).toMatchObject({
      code: "conflict",
      message: "It's been renamed since, so Undo would undo that too.",
    });
    expect(deletes()).toEqual([]);
    expect((await row(ev.id)).status).not.toBe("cancelled");
  });
});

describe("Undo for a task's block of time", () => {
  it("takes the block off your calendar", async () => {
    const task = await ok<{ id: string }>("task.create", {
      title: "Write the report",
      estimateMinutes: 60,
      dueAt: "2026-10-02T22:00:00Z",
    });
    await ok("calendar.block_task", { taskId: task.id }, jarvisCaller("owner"));
    const [v] = await undos();
    expect(v).toMatchObject({
      how: "made",
      did: "Added to your calendar: Focus: Write the report",
      label: 'Undo: take the block "Focus: Write the report" off your calendar',
      blocked: null,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect((await row(v!.entityId!)).status).toBe("cancelled");
    expect(deletes()[0]).toContain("sendUpdates=none");
  });

  it("stays off: the planner leaves the task be until its due date or estimate changes", async () => {
    const task = await ok<{ id: string }>("task.create", {
      title: "Write the report",
      estimateMinutes: 60,
      dueAt: "2026-10-02T22:00:00Z",
    });
    const plan = () =>
      ok<BlockResult>("calendar.block_task", { taskId: task.id }, jarvisCaller("owner"));
    expect(await plan()).toMatchObject({ created: 1 });
    const [v] = await undos();
    await ok("activity.undo", { ref: v!.ref });
    expect(await plan()).toMatchObject({ created: 0 });
    await ok("task.update", { id: task.id, title: "Write the whole report" });
    expect(await plan()).toMatchObject({ created: 0 });
    await ok("task.update", { id: task.id, dueAt: "2026-10-03T22:00:00Z" });
    expect(await plan()).toMatchObject({ created: 1 });
    await ok("activity.undo", { ref: (await undos())[0]!.ref });
    expect(await plan()).toMatchObject({ created: 0 });
    await ok("task.update", { id: task.id, estimateMinutes: 90 });
    expect((await plan()).created).toBeGreaterThan(0);
  });
});
