// What Calendar needs to move events by hand: calendar.events says which ones you can change and
// which Pip added, and your own drag goes through update_event (no guests) or update_meeting
// (guests are told), moving only the one time of a repeating meeting.
import { integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { EventView } from "./store.ts";

const ME = "owner@example.com";
const TEAM = "team@group.calendar.google.com";
const TUE = { start: "2026-10-06T14:00:00Z", end: "2026-10-06T15:00:00Z" };
const WED = { start: "2026-10-07T18:00:00Z", end: "2026-10-07T19:00:00Z" };
const WEEK = { from: "2026-10-05T00:00:00Z", to: "2026-10-19T00:00:00Z" };

type Listed = EventView & { canWrite: boolean; madeByPip: boolean };

let t: TestKernel;
let g: FakeGoogle;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.addCalendar({ id: TEAM, summary: "Team", accessRole: "reader" });
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  await sync();
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller = ownerCaller()): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("calendar.sync", {}, integrationCaller("google"));
const listed = async (title: string) => {
  const all = await ok<Listed[]>("calendar.events", WEEK);
  const one = all.find((e) => e.title === title);
  if (!one) throw new Error(`${title} isn't listed`);
  return one;
};
const atGoogle = (id: string) => g.calendars.get(ME)!.events.get(id);

describe("calendar.events, for dragging", () => {
  it("says which events you can change and which Pip added", async () => {
    await ok("calendar.create_event", { title: "Dentist", ...TUE });
    await ok("calendar.create_event", { title: "Focus", ...WED }, jarvisCaller("agent"));
    g.put(TEAM, { summary: "Offsite", start: { dateTime: TUE.start }, end: { dateTime: TUE.end } });
    const setup = await ok<{ calendars: { id: string; googleId: string }[] }>("calendar.calendars");
    const team = setup.calendars.find((c) => c.googleId === TEAM)!;
    await ok("calendar.choose", { id: team.id, selected: true });
    await sync();

    expect(await listed("Dentist")).toMatchObject({ canWrite: true, madeByPip: false });
    expect(await listed("Focus")).toMatchObject({ canWrite: true, madeByPip: true });
    expect(await listed("Offsite")).toMatchObject({ canWrite: false, madeByPip: false });
  });
});

describe("moving by hand", () => {
  it("moves your own event straight away", async () => {
    const ev = await ok<EventView>("calendar.create_event", { title: "Dentist", ...TUE });
    const moved = await ok<EventView>("calendar.update_event", { id: ev.id, ...WED });
    expect(moved.startsAt).toEqual(new Date(WED.start));
    expect(atGoogle(ev.googleId)?.start).toEqual({ dateTime: WED.start });
  });

  it("moves a meeting with guests only through update_meeting, without asking you", async () => {
    const ev = await ok<EventView>("calendar.schedule_meeting", {
      title: "Planning",
      ...TUE,
      attendees: ["sam@example.com"],
    });
    const direct = await t.kernel.execute(
      "calendar.update_event",
      { id: ev.id, ...WED },
      ownerCaller(),
    );
    expect(direct).toMatchObject({ status: "error", code: "forbidden" });
    const moved = await ok<EventView>("calendar.update_meeting", { id: ev.id, ...WED });
    expect(moved.startsAt).toEqual(new Date(WED.start));
    expect(atGoogle(ev.googleId)?.end).toEqual({ dateTime: WED.end });
  });

  it("moves one time of a repeating event, not the others", async () => {
    const times = ["2026-10-06T14:00:00Z", "2026-10-13T14:00:00Z"].map((start) =>
      g.put(ME, {
        id: `walk_${start.replace(/[-:]/g, "").slice(0, 15)}Z`,
        summary: "Walk",
        recurringEventId: "walk",
        start: { dateTime: start },
        end: { dateTime: start.replace("14:", "15:") },
      }),
    );
    await sync();
    const all = await ok<Listed[]>("calendar.events", WEEK);
    const first = all.find((e) => e.googleId === times[0]!.id)!;
    await ok("calendar.update_event", { id: first.id, ...WED });
    expect(atGoogle(times[0]!.id)?.start).toEqual({ dateTime: WED.start });
    expect(atGoogle(times[1]!.id)?.start).toEqual({ dateTime: "2026-10-13T14:00:00Z" });
  });
});
