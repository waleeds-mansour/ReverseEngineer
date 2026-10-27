// The calendar's own Undo, pressed from Today, What Pip did or the inbox: good for as long as the
// event is as Pip left it (however long ago), and greyed and refused once you've changed it, so it
// never undoes you. Taking back a yes says, where a phone shows it, that its organizer will see.
import { calendarEvent, entity } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventView } from "../calendar/store.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { UndoView } from "./shape.ts";

const ME = "owner@example.com";
const SAM = "sam@partner.example";
let t: TestKernel;
let g: FakeGoogle;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
/** Pip, after reading an email: what it changes on your calendar leaves a note with an Undo. */
const pip = () => jarvisCaller("untrusted", { correlationId: newId(), mode: "proactive" });
const notes = async () =>
  (await ok<UndoView[]>("activity.undos", { since: "2026-09-30T00:00:00Z" })).filter(
    (u) => u.ref.kind === "notification",
  );
const inbox = (v: UndoView) => ok<UndoView[]>("activity.undos", { ref: v.ref });
const press = (v: UndoView) => t.kernel.execute("activity.undo", { ref: v.ref }, ownerCaller());
const row = async (id: string) =>
  (await t.tdb.db.select().from(calendarEvent).where(eq(calendarEvent.entityId, id)))[0]!;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await ok("calendar.sync", {}, integrationCaller("google"));
});
afterEach(() => t.destroy());

async function dentistMovedByPip() {
  const ev = await ok<EventView>("calendar.create_event", {
    title: "Dentist",
    start: "2026-10-06T14:00:00Z",
    end: "2026-10-06T15:00:00Z",
  });
  await ok(
    "calendar.update_event",
    { id: ev.id, start: "2026-10-07T18:00:00Z", end: "2026-10-07T19:00:00Z" },
    pip(),
  );
  const [v] = await notes();
  expect(v).toMatchObject({ blocked: null, tells: null });
  return { ev, v: v! };
}

describe("the calendar's Undo, once you've changed the event", () => {
  it("is greyed and refused when you've moved it since, which it leaves where you put it", async () => {
    const { ev, v } = await dentistMovedByPip();
    t.clock.advance(60_000);
    await ok("calendar.update_event", {
      id: ev.id,
      start: "2026-10-08T18:00:00Z",
      end: "2026-10-08T19:00:00Z",
    });
    const [now] = await notes();
    expect(now).toMatchObject({ blocked: "You've changed it since", undone: false });
    expect(await inbox(v)).toMatchObject([{ blocked: "You've changed it since" }]);
    expect(await press(v)).toMatchObject({ status: "error", code: "conflict" });
    expect((await row(ev.id)).startsAt).toEqual(new Date("2026-10-08T18:00:00Z"));
  });

  it("is refused when it was moved at Google since Nook last looked", async () => {
    const { ev, v } = await dentistMovedByPip();
    const at = await row(ev.id);
    g.put(ME, {
      id: at.googleId,
      summary: "Dentist",
      start: { dateTime: "2026-10-09T18:00:00Z" },
      end: { dateTime: "2026-10-09T19:00:00Z" },
    });
    expect(await press(v)).toMatchObject({ code: "conflict" });
    expect((await row(ev.id)).startsAt).toEqual(new Date("2026-10-07T18:00:00Z"));
  });

  it("is refused when you've put a removed event back yourself, so it isn't added twice", async () => {
    const ev = await ok<EventView>("calendar.create_event", {
      title: "Dentist",
      start: "2026-10-06T14:00:00Z",
      end: "2026-10-06T15:00:00Z",
    });
    await ok("calendar.delete_event", { id: ev.id }, pip());
    const [v] = await notes();
    expect(v).toMatchObject({ blocked: null });
    t.clock.advance(60_000);
    await ok("calendar.create_event", {
      title: "Dentist",
      start: "2026-10-06T14:00:00Z",
      end: "2026-10-06T15:00:00Z",
    });
    expect((await notes())[0]).toMatchObject({ blocked: "It's back on your calendar" });
    expect(await press(v!)).toMatchObject({ code: "conflict" });
    const live = await t.tdb.db
      .select()
      .from(calendarEvent)
      .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
      .where(and(eq(entity.title, "Dentist"), ne(calendarEvent.status, "cancelled")));
    expect(live).toHaveLength(1);
  });

  it("stays good past a week while the event is as Pip left it", async () => {
    const { ev, v } = await dentistMovedByPip();
    t.clock.advance(9 * 86_400_000);
    expect((await notes())[0]).toMatchObject({ blocked: null });
    expect(await inbox(v)).toMatchObject([{ blocked: null }]);
    await ok("activity.undo", { ref: v.ref });
    expect((await row(ev.id)).startsAt).toEqual(new Date("2026-10-06T14:00:00Z"));
  });
});

describe("taking back a yes Pip gave", () => {
  it("says beside the button that its organizer will see, and answers it again as unanswered", async () => {
    const p = await ok<{ id: string }>("person.create", { name: "Sam Lee" });
    await ok("person.add_email", { id: p.id, email: SAM });
    g.put(ME, {
      id: "standup",
      summary: "Standup",
      organizer: { email: SAM },
      attendees: [
        { email: SAM, organizer: true, responseStatus: "accepted" },
        { email: ME, self: true, responseStatus: "needsAction" },
      ],
      start: { dateTime: "2026-10-06T15:00:00Z" },
      end: { dateTime: "2026-10-06T16:00:00Z" },
    });
    await ok("calendar.sync", {}, integrationCaller("google"));
    const [ev] = await t.tdb.db
      .select()
      .from(calendarEvent)
      .where(eq(calendarEvent.googleId, "standup"));
    await ok("calendar.accept_invite", { id: ev!.entityId }, pip());
    const [v] = await notes();
    expect(v).toMatchObject({
      label: 'Undo: take back the yes to "Standup"; its organizer will see',
      tells: "Its organizer will see",
      blocked: null,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect(await row(ev!.entityId)).toMatchObject({ selfResponse: "needsAction" });
    expect((await notes())[0]).toMatchObject({ blocked: "Undone", undone: true, tells: null });
  });
});
