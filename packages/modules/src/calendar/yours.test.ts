// Pip changing your own events on its own, even in a turn that read an email (the owner,
// 2026-10-27): one with no guests on your own calendar it moves, changes or removes without asking,
// and tells you with Undo. Anything guests would see still waits for your yes.
import { calendarEvent, notification } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { EventView } from "./store.ts";

const ME = "owner@example.com";
const TUE = { start: "2026-10-06T14:00:00Z", end: "2026-10-06T15:00:00Z" };
const WED = { start: "2026-10-07T18:00:00Z", end: "2026-10-07T19:00:00Z" };

let t: TestKernel;
let g: FakeGoogle;
const fromMail = jarvisCaller("untrusted", { mode: "proactive" });

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const add = () => ok<EventView>("calendar.create_event", { title: "Dentist", ...TUE });
const writes = () => g.calls.filter((c) => c.method !== "GET" && c.path.startsWith("/calendar/"));
const notes = () => t.tdb.db.select().from(notification);
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
/** The event at Google, as if you'd changed it in Google's own app. */
const atGoogle = (ev: EventView, more: Record<string, unknown>) =>
  g.put(ME, {
    id: ev.googleId,
    summary: "Dentist",
    start: { dateTime: TUE.start },
    end: { dateTime: TUE.end },
    ...more,
  });

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await sync();
});
afterEach(() => t.destroy());

describe("your own event, from a turn that read an email", () => {
  it("moves without asking, and Undo moves it back", async () => {
    const ev = await add();
    const moved = await ok<EventView>("calendar.update_event", { id: ev.id, ...WED }, fromMail);
    expect(moved.startsAt).toEqual(new Date(WED.start));
    expect(writes().at(-1)).toMatchObject({
      method: "PATCH",
      body: { start: { dateTime: WED.start }, end: { dateTime: WED.end } },
    });
    const [n] = await notes();
    expect(n).toMatchObject({
      kind: "calendar.moved",
      title: 'Moved "Dentist" to Wed 2026-10-07, 2 p.m.',
      body: expect.stringMatching(/without asking\. It was Tue 2026-10-06, 10 a\.m\.$/),
      outside: true,
      undo: { kind: "unmove", eventId: ev.id, before: { start: "2026-10-06T14:00:00.000Z" } },
    });
    await ok("calendar.undo", { notificationId: n!.id });
    const [back] = await t.tdb.db
      .select()
      .from(calendarEvent)
      .where(eq(calendarEvent.entityId, ev.id));
    expect(back!.startsAt).toEqual(new Date(TUE.start));
  });

  it("changes its title, and says so", async () => {
    const ev = await add();
    await ok("calendar.update_event", { id: ev.id, title: "Dentist (cleaning)" }, fromMail);
    const [n] = await notes();
    expect(n).toMatchObject({ kind: "calendar.changed", undo: null, entityId: ev.id });
    expect(n!.title).toMatch(/^Changed "Dentist \(cleaning\)", Tue 2026-10-06/);
  });

  it("removes without asking, and Undo puts it back", async () => {
    const ev = await add();
    await ok("calendar.delete_event", { id: ev.id }, fromMail);
    expect(writes().at(-1)).toMatchObject({ method: "DELETE" });
    const [n] = await notes();
    expect(n).toMatchObject({ kind: "calendar.removed", undo: { kind: "unremove" } });
    const before = writes().length;
    await ok("calendar.undo", { notificationId: n!.id });
    expect(writes().slice(before)).toMatchObject([{ method: "POST" }]);
  });

  it("leaves no note when you asked for it yourself", async () => {
    const ev = await add();
    await ok("calendar.update_event", { id: ev.id, ...WED }, jarvisCaller("owner"));
    expect(await notes()).toEqual([]);
  });
});

describe("an event guests or other people see", () => {
  it("is refused with guests, and the meeting's own action asks", async () => {
    const ev = await add();
    atGoogle(ev, {
      organizer: { email: ME, self: true },
      attendees: [
        { email: ME, self: true, organizer: true, responseStatus: "accepted" },
        { email: "ana@friends.example", responseStatus: "needsAction" },
      ],
    });
    await sync();
    const before = writes().length;
    for (const [action, input, use] of [
      ["calendar.update_event", { id: ev.id, ...WED }, "calendar_update_meeting"],
      ["calendar.delete_event", { id: ev.id }, "calendar_cancel_meeting"],
    ] as const)
      expect(await t.kernel.execute(action, input, fromMail)).toMatchObject({
        status: "error",
        code: "forbidden",
        message: expect.stringContaining(`Use ${use}, which asks the owner first.`),
      });
    const meeting = await t.kernel.execute(
      "calendar.update_meeting",
      { id: ev.id, ...WED },
      fromMail,
    );
    expect(meeting.status).toBe("pending_approval");
    expect(writes()).toHaveLength(before);
  });

  it("is refused when guests were added at Google since the last sync", async () => {
    const ev = await add();
    atGoogle(ev, { attendees: [{ email: "ana@friends.example" }] });
    const before = writes().length;
    const res = await t.kernel.execute("calendar.update_event", { id: ev.id, ...WED }, fromMail);
    expect(res).toMatchObject({ status: "error", code: "forbidden" });
    expect(writes()).toHaveLength(before);
    expect(await notes()).toEqual([]);
  });

  it("is refused on a calendar other people see", async () => {
    g.addCalendar({ id: "team@group.example", summary: "Team", accessRole: "writer" });
    await sync();
    const ev = await ok<EventView>("calendar.create_event", {
      title: "Offsite",
      ...TUE,
      calendarId: "team@group.example",
    });
    const res = await t.kernel.execute("calendar.delete_event", { id: ev.id }, fromMail);
    expect(res).toMatchObject({
      status: "error",
      code: "forbidden",
      message: expect.stringMatching(/^This event is on a calendar other people see/),
    });
  });
});
