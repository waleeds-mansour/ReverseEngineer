// A meeting that reaches two of your addresses is listed once (D61): as the copy you organize, so
// Jarvis can change it, else the one you said yes to, the same copy on every read, and its prep and
// notes found from whichever copy has them.
import { calendarEvent } from "@hearth/db";
import { getSetting, type HearthEvent, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tomorrowAtAGlance } from "../assistant/wrap.ts";
import type { GAttendee, GEvent } from "../google/calendar-api.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import type { PersonSummary, PersonView } from "../people/views.ts";
import { type Copy, oneEach } from "./copies.ts";
import { calendarModule } from "./index.ts";
import { eventsToPrep, prepRoutine } from "./prep.ts";

const ME = "owner@example.com";
const WORK = "work@example.com";
const ANA = "ana@example.com";
const RANGE = { from: "2026-10-01T00:00:00Z", to: "2026-10-12T00:00:00Z" };
const RANGE_START = new Date(RANGE.from);

let t: TestKernel;
let g: FakeGoogle;

async function signIn(email: string) {
  g.signingIn = email;
  const client = g.client(t.tdb.db);
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
}

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
  g.addAccount(WORK);
  t.kernel.services[GOOGLE_SERVICE] = g.client(t.tdb.db);
  await signIn(ME);
  t.clock.advance(60_000);
  await signIn(WORK);
});
afterEach(() => t.destroy());

const run = async <T>(action: string, input: unknown = {}) => {
  const res = await t.kernel.execute<T>(action, input, ownerCaller());
  if (res.status !== "ok") throw new Error(JSON.stringify(res));
  return res.result;
};
const sync = () => t.kernel.execute("calendar.sync", {}, integrationCaller("google"));
const at = (iso: string) => ({ dateTime: iso });

interface Listed {
  id: string;
  title: string;
  selfOrganizer: boolean;
  selfResponse: string | null;
  status: string;
  prepId?: string;
}
const listed = async (more: object = {}) =>
  (await run<Listed[]>("calendar.events", { ...RANGE, ...more })).filter(
    (e) => e.title === "Design sync",
  );
const calendarRow = async (account: string, googleId: string) =>
  (
    await run<{ calendars: { id: string; account: string; googleId: string }[] }>(
      "calendar.calendars",
    )
  ).calendars.find((c) => c.account === account && c.googleId === googleId)!;

/** An invitation to "Design sync" at one of your addresses. */
const invitation = (self: string, response: GAttendee["responseStatus"], organizer = ANA) => ({
  summary: "Design sync",
  iCalUID: "design-1@google.com",
  start: at("2026-10-02T16:00:00Z"),
  end: at("2026-10-02T17:00:00Z"),
  organizer: { email: organizer },
  attendees: [
    { email: organizer, organizer: true, responseStatus: "accepted" as const },
    { email: self, self: true, responseStatus: response },
  ],
});

/** Jarvis schedules "Design sync" with Ana and your work address; work says yes. */
async function scheduleWithWork(calendarId: string) {
  await run("calendar.schedule_meeting", {
    title: "Design sync",
    start: "2026-10-02T16:00:00Z",
    end: "2026-10-02T17:00:00Z",
    attendees: [ANA, WORK],
  });
  const made = [...g.calendars.get(calendarId)!.events.values()].find(
    (e) => e.summary === "Design sync",
  ) as GEvent;
  made.iCalUID = "design-1@google.com";
  g.put(WORK, invitation(WORK, "accepted", ME));
  await sync();
}

describe("a meeting at two of your addresses", () => {
  it("shows the copy you organize, which Jarvis can move", async () => {
    await sync();
    await scheduleWithWork(ME);
    const [shown, ...more] = await listed();
    expect(more).toEqual([]);
    expect(shown).toMatchObject({ selfOrganizer: true, selfResponse: null });
    await run("calendar.update_meeting", {
      id: shown!.id,
      start: "2026-10-02T18:00:00Z",
      end: "2026-10-02T19:00:00Z",
    });
  });

  it("counts the calendar new events go to as yours", async () => {
    g.shareCalendar({ id: "side", summary: "Side projects" }, { [ME]: "owner" });
    await sync();
    await run("calendar.set_default", { id: (await calendarRow(ME, "side")).id });
    await scheduleWithWork("side");
    const [shown] = await listed();
    expect(shown).toMatchObject({ selfOrganizer: true });
  });

  it("shows your invitation over a colleague's copy on a calendar you can write to", async () => {
    g.shareCalendar({ id: ANA, summary: "Ana" }, { [ME]: "writer" });
    const hers = invitation(ANA, "accepted");
    g.put(ANA, { ...hers, organizer: { email: ANA, self: true } });
    g.put(ME, invitation(ME, "needsAction"));
    await sync();
    await run("calendar.choose", { id: (await calendarRow(ME, ANA)).id, selected: true });
    await sync();
    expect(await listed()).toMatchObject([{ selfOrganizer: false, selfResponse: "needsAction" }]);
  });

  it("says a meeting is cancelled only when every copy is", async () => {
    g.put(ME, invitation(ME, "needsAction"));
    const work = g.put(WORK, invitation(WORK, "accepted"));
    await sync();
    g.remove(WORK, work.id);
    await sync();
    expect(await listed({ includeCancelled: true })).toMatchObject([
      { status: "confirmed", selfResponse: "needsAction" },
    ]);
  });

  it("keeps a copy Pip cancels with its meeting", async () => {
    await sync();
    await scheduleWithWork(ME);
    const [shown] = await listed();
    await run("calendar.cancel_meeting", { id: shown!.id });
    expect(await listed({ includeCancelled: true })).toHaveLength(1);
  });

  it("finds the prep and notes made on the copy that isn't shown", async () => {
    g.put(ME, invitation(ME, "needsAction"));
    await sync();
    const [first] = await listed();
    const prep = await run<{ id: string }>("prep.publish", {
      eventId: first!.id,
      markdown: "Bring the mockups.",
    });
    const notes = await run<{ id: string }>("meeting.start", { eventId: first!.id });
    g.put(WORK, invitation(WORK, "accepted"));
    await sync();
    const [shown] = await listed();
    expect(shown).toMatchObject({ selfResponse: "accepted", prepId: prep.id });
    expect(shown!.id).not.toBe(first!.id);
    expect(await run("calendar.get", { id: shown!.id })).toMatchObject({ prepId: prep.id });
    expect(await run("meeting.start", { eventId: shown!.id })).toEqual(notes);
  });
});

describe("a meeting at two of your addresses, wherever it's listed", () => {
  const both = async () => {
    g.put(ME, invitation(ME, "needsAction"));
    g.put(WORK, invitation(WORK, "accepted"));
    await sync();
  };

  it("is one line in the brief, on the evening card and on a guest's page", async () => {
    await both();
    const { timeZone } = await getSetting(t.tdb.db, "owner.dayRules");
    const card = await tomorrowAtAGlance(t.tdb.db, "2026-10-01", timeZone);
    expect(card.match(/Design sync/g)).toHaveLength(1);
    const ana = (await run<PersonSummary[]>("person.list")).find((p) => /ana/i.test(p.name));
    const page = await run<PersonView>("person.view", { id: ana!.id });
    expect(page.upcoming.map((e) => e.title)).toEqual(["Design sync"]);
    // The morning of: the copy you said yes to.
    t.clock.set("2026-10-02T11:00:00Z");
    const items = await calendarModule.digest!({
      db: t.tdb.db,
      now: t.clock.now(),
      since: RANGE_START,
    });
    expect(items.map((i) => i.text).filter((x) => x.includes("Design sync"))).toEqual([
      expect.stringMatching(/ Design sync$/),
    ]);
  });

  it("gets one prep packet, whichever copy it's written for", async () => {
    g.put(ME, invitation(ME, "needsAction"));
    await sync();
    const [first] = await listed();
    const prep = await run<{ id: string }>("prep.publish", { eventId: first!.id, markdown: "A" });
    g.put(WORK, invitation(WORK, "accepted"));
    await sync();
    const [shown] = await listed();
    expect(shown!.id).not.toBe(first!.id);
    const ctx = { db: t.tdb.db, now: t.clock.now() };
    expect((await eventsToPrep(ctx)).map((v) => v.id)).toEqual([shown!.id]);
    // It has its packet, so the morning's prep leaves it be, and writing it again changes that one.
    const firing = {
      scheduledFor: t.clock.now(),
      event: {} as HearthEvent,
      digest: async () => [],
    };
    expect(await prepRoutine.run(firing, ctx)).toEqual([]);
    expect(await run("prep.publish", { eventId: shown!.id, markdown: "B" })).toEqual(prep);
  });

  it("records into new notes once the notes taken on either copy have ended", async () => {
    // Two meetings, so the notes are on the copy found first in one and the other in the other.
    const later = (self: string, response: GAttendee["responseStatus"]) => ({
      ...invitation(self, response),
      iCalUID: "design-2@google.com",
      start: at("2026-10-05T16:00:00Z"),
      end: at("2026-10-05T17:00:00Z"),
    });
    await both();
    g.put(ME, later(ME, "needsAction"));
    g.put(WORK, later(WORK, "accepted"));
    await sync();
    const rows = await t.tdb.db
      .select({ id: calendarEvent.entityId, at: calendarEvent.startsAt })
      .from(calendarEvent);
    for (const [i, day] of ["2026-10-02", "2026-10-05"].entries()) {
      const these = rows.filter((e) => e.at.toISOString().startsWith(day)).map((e) => e.id);
      expect(these).toHaveLength(2);
      const notes = await run<{ id: string }>("meeting.start", { eventId: these.sort()[i]! });
      t.clock.set(`${day}T16:10:00Z`);
      await run("meeting.end", { id: notes.id });
      const recording = await run<{ id: string }>("meeting.record");
      expect(recording.id).not.toBe(notes.id);
    }
  });
});

describe("oneEach", () => {
  const copy = (id: string, own: string | null, selfResponse = "accepted"): Copy => ({
    e: { id },
    r: {
      icalUid: "x",
      googleId: id,
      startsAt: new Date("2026-10-02T16:00:00Z"),
      selfResponse,
      selfOrganizer: false,
      status: "confirmed",
    },
    own,
    writeDefault: false,
  });

  it("shows the same copy of a tie whatever order the rows come in", () => {
    const rows = [copy("b", ME), copy("a", WORK)];
    expect(oneEach(rows)[0]!.shown.e.id).toBe("a");
    expect(oneEach(rows.reverse())[0]!.shown.e.id).toBe("a");
  });

  it("shows your no over the copy you haven't answered, so it isn't asked again", () => {
    const rows = [copy("a", WORK, "needsAction"), copy("b", ME, "declined")];
    expect(oneEach(rows)[0]!.shown.e.id).toBe("b");
    expect(oneEach([...rows, copy("c", WORK, "accepted")])[0]!.shown.e.id).toBe("c");
  });
});
