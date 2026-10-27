// Moving events on Calendar by hand: a press is a click till it moves a few px; blocks move by
// quarter hours from where they were (a sideways drag keeps the minute) and stay inside their day;
// the bottom edge stretches by quarters, never past midnight or, shrinking, under a quarter hour; a
// month's chip keeps its time on another day; only events Nook can write, that you organize when
// they have guests, move; a meeting's move tells its guests, and asks first by name and time.
import { describe, expect, it } from "vitest";
import {
  canDrag,
  cellAt,
  columnAt,
  dateOf,
  endsOn,
  guestCount,
  moveBlock,
  moveDays,
  moveInput,
  moveQuestion,
  pastSlop,
  resizeBlock,
  sameSpan,
  shifted,
  snap,
  toMinutes,
  toPx,
} from "./calDrag.ts";
import type { CalEvent } from "./types.ts";

const day = new Date(2026, 9, 27);
const at = (h: number, m = 0, d = 27) => new Date(2026, 9, d, h, m);
const span = (a: Date, b: Date) => ({ start: a, end: b });
const ev = (more: Partial<CalEvent> = {}) =>
  ({
    id: "e1",
    allDay: false,
    status: "confirmed",
    selfOrganizer: true,
    attendees: [],
    ...more,
  }) as unknown as CalEvent;
const sam = { email: "sam@example.com" };
const me = { email: "me@example.com", self: true };

describe("picking up", () => {
  it("is a click until the pointer moves past a few px", () => {
    expect(pastSlop(2, 2)).toBe(false);
    expect(pastSlop(0, 4)).toBe(false);
    expect(pastSlop(0, 5)).toBe(true);
    expect(pastSlop(-3, 3)).toBe(true);
  });

  it("turns px into minutes and back, 48 px to an hour", () => {
    expect(toMinutes(48, 48)).toBe(60);
    expect(toMinutes(-12, 48)).toBe(-15);
    expect(toPx(90, 48)).toBe(72);
  });

  it("snaps to the quarter hour", () => {
    expect(snap(7)).toBe(0);
    expect(snap(8)).toBe(15);
    expect(snap(-8)).toBe(-15);
    expect(snap(620)).toBe(615);
  });
});

describe("where the pointer is", () => {
  const cols = [0, 100, 200].map((left) => ({ left, right: left + 100 }));
  it("finds the day column under it, and the end one past either side", () => {
    expect(columnAt(150, cols)).toBe(1);
    expect(columnAt(200, cols)).toBe(2);
    expect(columnAt(-40, cols)).toBe(0);
    expect(columnAt(900, cols)).toBe(2);
    expect(columnAt(5, [])).toBe(-1);
  });

  it("finds a month's cell under it, or none", () => {
    const cells = [
      { left: 0, right: 100, top: 0, bottom: 80 },
      { left: 100, right: 200, top: 0, bottom: 80 },
      { left: 0, right: 100, top: 80, bottom: 160 },
    ];
    expect(cellAt(150, 10, cells)).toBe(1);
    expect(cellAt(10, 100, cells)).toBe(2);
    expect(cellAt(150, 100, cells)).toBe(-1);
  });
});

describe("moving a block in the week", () => {
  const dentist = span(at(10), at(11));

  it("moves down and up by quarter hours, keeping its length", () => {
    const down = moveBlock(dentist, day, 37, day);
    expect(down).toMatchObject({ start: at(10, 30), end: at(11, 30), shift: 30 });
    expect(moveBlock(dentist, day, -50, day)).toMatchObject({ start: at(9, 15), end: at(10, 15) });
  });

  it("stays where it was for a nudge under half a quarter", () => {
    expect(sameSpan(moveBlock(dentist, day, 7, day), dentist)).toBe(true);
  });

  it("moves an odd start by quarter hours from where it was", () => {
    const odd = span(at(10, 5), at(10, 50));
    expect(moveBlock(odd, day, 6, day).start).toEqual(at(10, 5));
    expect(moveBlock(odd, day, 10, day)).toMatchObject({ start: at(10, 20), end: at(11, 5) });
  });

  it("keeps 10:20 at 10:20 when it's dragged straight to another day", () => {
    const wed = new Date(2026, 9, 28);
    const standup = span(at(10, 20), at(10, 35));
    expect(moveBlock(standup, day, 0, wed)).toMatchObject({
      start: at(10, 20, 28),
      end: at(10, 35, 28),
      shift: 0,
    });
    // A hand that wobbles a little on the way keeps the minute too.
    expect(moveBlock(standup, day, 3, wed).start).toEqual(at(10, 20, 28));
    expect(moveBlock(standup, day, -7, wed).start).toEqual(at(10, 20, 28));
  });

  it("goes to another day at the time it's dropped", () => {
    const wed = new Date(2026, 9, 28);
    expect(moveBlock(dentist, day, 60, wed)).toMatchObject({
      start: at(11, 0, 28),
      end: at(12, 0, 28),
    });
    const mon = new Date(2026, 9, 26);
    expect(moveBlock(dentist, day, 0, mon).start).toEqual(at(10, 0, 26));
  });

  it("stays inside its day at either end", () => {
    expect(moveBlock(dentist, day, -900, day).start).toEqual(at(0));
    expect(moveBlock(dentist, day, 900, day)).toMatchObject({ start: at(23), end: at(0, 0, 28) });
  });

  it("keeps an hour an hour across the clocks going back", () => {
    // Clocks go back in Europe on 2026-10-25 and in America on 2026-11-01; length is kept in ms.
    const sun = new Date(2026, 9, 25);
    const early = span(new Date(2026, 9, 24, 23), new Date(2026, 9, 25, 0));
    const moved = moveBlock(early, new Date(2026, 9, 24), 0, sun);
    expect(moved.end.getTime() - moved.start.getTime()).toBe(3_600_000);
  });
});

describe("stretching a block's bottom edge", () => {
  const dentist = span(at(10), at(11));

  it("moves the end by quarter hours and leaves the start", () => {
    expect(resizeBlock(dentist, day, 31)).toEqual(span(at(10), at(11, 30)));
    expect(resizeBlock(dentist, day, -30)).toEqual(span(at(10), at(10, 30)));
  });

  it("keeps at least a quarter hour, and stops at midnight", () => {
    expect(resizeBlock(dentist, day, -200)).toEqual(span(at(10), at(10, 15)));
    expect(resizeBlock(dentist, day, 2000)).toEqual(span(at(10), at(0, 0, 28)));
  });

  it("moves an odd end by quarter hours from where it was, and leaves it for a nudge", () => {
    const odd = span(at(10), at(10, 50));
    expect(resizeBlock(odd, day, 16)).toEqual(span(at(10), at(11, 5)));
    expect(resizeBlock(odd, day, 5)).toBe(odd);
  });

  it("stretches a short event, and never stretches it by shrinking", () => {
    const short = span(at(10), at(10, 10));
    expect(resizeBlock(short, day, 15)).toEqual(span(at(10), at(10, 25)));
    expect(resizeBlock(short, day, -30)).toEqual(short);
  });

  it("has its edge only on the day it ends", () => {
    const late = span(at(23), at(1, 0, 28));
    expect(endsOn(late, day)).toBe(false);
    expect(endsOn(late, new Date(2026, 9, 28))).toBe(true);
    expect(endsOn(dentist, day)).toBe(true);
    expect(endsOn(span(at(9), at(0, 0, 28)), day)).toBe(true);
  });
});

describe("moving across days", () => {
  it("keeps the time of day on another day", () => {
    const from = new Date(2026, 9, 27);
    const to = new Date(2026, 10, 3);
    expect(moveDays(span(at(15, 30), at(16, 45)), from, to)).toEqual(
      span(new Date(2026, 10, 3, 15, 30), new Date(2026, 10, 3, 16, 45)),
    );
  });

  it("moves an all-day event's days, to its dates", () => {
    const moved = moveDays(span(at(0), at(0, 0, 29)), day, new Date(2026, 9, 30));
    expect([dateOf(moved.start), dateOf(moved.end)]).toEqual(["2026-10-30", "2026-11-01"]);
    expect(shifted(at(0), -27).getDate()).toBe(30);
  });
});

describe("what can move, and how it's saved", () => {
  it("moves events on calendars Nook can write, and meetings you organize", () => {
    expect(canDrag(ev())).toBe(true);
    expect(canDrag(ev({ canWrite: undefined }))).toBe(true);
    expect(canDrag(ev({ canWrite: false }))).toBe(false);
    expect(canDrag(ev({ status: "cancelled" }))).toBe(false);
    expect(canDrag(ev({ attendees: [me, sam] }))).toBe(true);
    expect(canDrag(ev({ attendees: [me, sam], selfOrganizer: false }))).toBe(false);
    expect(canDrag(ev({ attendees: [me], selfOrganizer: false }))).toBe(true);
  });

  it("counts guests without you", () => {
    expect(guestCount(ev({ attendees: [me, sam, { email: "lee@example.com" }] }))).toBe(2);
    expect(guestCount(ev({ attendees: [me] }))).toBe(0);
  });

  it("saves your own event straight away, and a meeting through update_meeting", () => {
    const to = span(new Date("2026-10-27T14:00:00Z"), new Date("2026-10-27T15:00:00Z"));
    expect(moveInput(ev(), to)).toEqual({
      action: "calendar.update_event",
      input: { id: "e1", start: "2026-10-27T14:00:00.000Z", end: "2026-10-27T15:00:00.000Z" },
    });
    expect(moveInput(ev({ attendees: [me, sam] }), to).action).toBe("calendar.update_meeting");
  });

  it("saves an all-day event as dates", () => {
    const to = span(at(0, 0, 30), at(0, 0, 31));
    expect(moveInput(ev({ allDay: true }), to).input).toEqual({
      id: "e1",
      start: "2026-10-30",
      end: "2026-10-31",
    });
  });

  it("asks by the meeting's name and where it goes", () => {
    const now = new Date(2026, 9, 27);
    const to = span(at(10, 30, 29), at(11, 0, 29));
    expect(moveQuestion(ev({ title: "Standup" }), to, 3, now)).toBe(
      "Move “Standup” to Thu, Oct 29, 10:30 a.m. and tell 3 guests?",
    );
    expect(moveQuestion(ev({ title: "Offsite", allDay: true }), to, 1, now)).toBe(
      "Move “Offsite” to Thu, Oct 29 and tell 1 guest?",
    );
  });
});
