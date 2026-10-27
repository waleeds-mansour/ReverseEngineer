// Calendar's layout: events that overlap sit side by side, packed as Google Calendar packs them;
// all-day events take lanes; weeks start where the locale says, Sunday or Monday; a month is six
// weeks with three events a day before "+N more"; the line for now sits at the minute; a popover
// opens beside its event and stays on screen.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allDayLanes,
  dayColumn,
  daysBetween,
  firstWeekday,
  fitCell,
  inAllDayRow,
  minuteOf,
  monthDays,
  nowMinute,
  onDay,
  pack,
  popoverAt,
  weekStart,
} from "./calLayout.ts";
import type { CalEvent } from "./types.ts";

const day = new Date(2026, 9, 27);
const at = (h: number, m = 0, d = 27) => new Date(2026, 9, d, h, m).toISOString();
const ev = (id: string, startsAt: string, endsAt: string, allDay = false) =>
  ({ id, startsAt, endsAt, allDay }) as CalEvent;
/** Each placed event as "id col/cols span", in the order they're drawn. */
const placed = (events: CalEvent[]) =>
  dayColumn(events, day).map((p) => `${p.item.id} ${p.col}/${p.cols} ${p.span}`);

describe("a day's column", () => {
  it("puts events that don't overlap full width, and ones that do side by side", () => {
    expect(placed([ev("a", at(9), at(10)), ev("b", at(10), at(11))])).toEqual([
      "a 0/1 1",
      "b 0/1 1",
    ]);
    expect(placed([ev("a", at(9), at(11)), ev("b", at(10), at(12))])).toEqual([
      "a 0/2 1",
      "b 1/2 1",
    ]);
  });

  it("keeps a cluster as narrow as its busiest moment, and stretches into free columns", () => {
    // a overlaps b and c, which don't overlap each other: two columns, c under b.
    // d overlaps nothing, so it's full width again.
    expect(
      placed([
        ev("a", at(9), at(12)),
        ev("b", at(9, 30), at(10, 30)),
        ev("c", at(10, 30), at(11, 30)),
        ev("d", at(13), at(14)),
      ]),
    ).toEqual(["a 0/2 1", "b 1/2 1", "c 1/2 1", "d 0/1 1"]);
    // Three at once at 10: three columns, and e takes a's once a ends.
    expect(
      placed([
        ev("a", at(9), at(10, 30)),
        ev("b", at(9, 30), at(12)),
        ev("c", at(10), at(12)),
        ev("e", at(10, 30), at(11)),
      ]),
    ).toEqual(["a 0/3 1", "b 1/3 1", "c 2/3 1", "e 0/3 1"]);
    expect(
      pack([
        { item: "long", top: 0, bottom: 120 },
        { item: "x", top: 0, bottom: 30 },
        { item: "y", top: 60, bottom: 90 },
      ]).map((p) => `${p.item} ${p.col}/${p.cols} ${p.span}`),
    ).toEqual(["long 0/2 1", "x 1/2 1", "y 1/2 1"]);
    expect(
      pack([
        { item: "x", top: 0, bottom: 30 },
        { item: "y", top: 0, bottom: 30 },
        { item: "z", top: 20, bottom: 60 },
        { item: "w", top: 40, bottom: 60 },
      ]).map((p) => `${p.item} ${p.col}/${p.cols} ${p.span}`),
    ).toEqual(["x 0/3 1", "y 1/3 1", "z 2/3 1", "w 0/3 2"]);
  });

  it("draws a short event tall enough to read, and cuts one across midnight to the day", () => {
    const [short] = dayColumn([ev("s", at(9), at(9, 5))], day);
    expect([short!.top, short!.bottom]).toEqual([540, 560]);
    // Short ones pack as tall as they're drawn: these two would touch otherwise.
    expect(placed([ev("s", at(9), at(9, 5)), ev("t", at(9, 10), at(9, 30))])).toEqual([
      "s 0/2 1",
      "t 1/2 1",
    ]);
    const late = ev("late", at(22), at(2, 0, 28));
    const [tonight] = dayColumn([late], day);
    expect([tonight!.top, tonight!.bottom]).toEqual([1320, 1440]);
    const [tomorrow] = dayColumn([late], new Date(2026, 9, 28));
    expect([tomorrow!.top, tomorrow!.bottom]).toEqual([0, 120]);
    // One at the very end of the day stays inside it.
    const [last] = dayColumn([ev("x", at(23, 55), at(23, 59))], day);
    expect([last!.top, last!.bottom]).toEqual([1420, 1440]);
    expect(dayColumn([ev("y", at(9, 0, 26), at(10, 0, 26))], day)).toEqual([]);
  });

  it("puts all-day events and ones a day or longer above the hours", () => {
    expect(inAllDayRow(ev("a", at(0), at(0, 0, 28), true))).toBe(true);
    expect(inAllDayRow(ev("trip", at(9), at(9, 0, 28)))).toBe(true);
    expect(inAllDayRow(ev("late", at(22), at(2, 0, 28)))).toBe(false);
  });
});

describe("the all-day row", () => {
  const days = Array.from({ length: 7 }, (_, i) => new Date(2026, 9, 27 + i));
  it("runs each event across its days, in the first lane free for all of them", () => {
    const lanes = allDayLanes(
      [
        ev("trip", at(0, 0, 25), at(0, 0, 30), true),
        ev("holiday", at(0, 0, 28), at(0, 0, 29), true),
        ev("conf", at(0, 0, 29), at(0, 0, 31), true),
        // Nov 2 to Nov 5: from the last day shown on past it.
        ev("move", at(0, 0, 33), at(0, 0, 36), true),
        ev("gone", at(0, 0, 20), at(0, 0, 21), true),
      ],
      days,
    );
    expect(lanes.map((l) => `${l.item.id} ${l.col}+${l.span} lane ${l.lane}`)).toEqual([
      "trip 0+3 lane 0",
      "holiday 1+1 lane 1",
      "conf 2+2 lane 1",
      "move 6+1 lane 0",
    ]);
    expect(lanes[0]).toMatchObject({ before: true, after: false });
    expect(lanes[3]).toMatchObject({ before: false, after: true });
  });
});

describe("the week", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts on the day it does where you are, or on Sunday when the browser can't say", () => {
    expect(firstWeekday("en-US")).toBe(0);
    expect(firstWeekday("en-GB")).toBe(1);
    expect(firstWeekday("de-DE")).toBe(1);
    expect(firstWeekday("not a locale")).toBe(0);
    // Newer browsers ask with getWeekInfo(); older ones have weekInfo; some have neither.
    const intl = (api: object) =>
      vi.stubGlobal("Intl", Object.assign(Object.create(Intl), { Locale: class {} }, api));
    intl({
      Locale: class {
        getWeekInfo = () => ({ firstDay: 6 });
      },
    });
    expect(firstWeekday("ar-EG")).toBe(6);
    intl({
      Locale: class {
        weekInfo = { firstDay: 7 };
      },
    });
    expect(firstWeekday("en-US")).toBe(0);
    intl({});
    expect(firstWeekday("de-DE")).toBe(0);
  });

  it("starts each day's week on that day", () => {
    // Tuesday the 27th, and Sunday the 25th.
    expect(weekStart(day, 0)).toEqual(new Date(2026, 9, 25));
    expect(weekStart(day, 1)).toEqual(new Date(2026, 9, 26));
    expect(weekStart(new Date(2026, 9, 25, 15), 0)).toEqual(new Date(2026, 9, 25));
    expect(weekStart(new Date(2026, 9, 25, 15), 1)).toEqual(new Date(2026, 9, 19));
  });
});

describe("a month", () => {
  it("is six weeks from the start of the week its first day is in", () => {
    // October 2026 starts on a Thursday.
    const sunday = monthDays(new Date(2026, 9, 15), 0);
    expect(sunday).toHaveLength(42);
    expect([sunday[0], sunday[41]]).toEqual([new Date(2026, 8, 27), new Date(2026, 10, 7)]);
    expect(new Set(sunday.map((d) => d.getDay())).size).toBe(7);
    const monday = monthDays(new Date(2026, 9, 15), 1);
    expect([monday[0], monday[41]]).toEqual([new Date(2026, 8, 28), new Date(2026, 10, 8)]);
    // November starts on a Sunday: a Sunday grid starts on it, a Monday one six days before.
    expect(monthDays(new Date(2026, 10, 1), 0)[0]).toEqual(new Date(2026, 10, 1));
    expect(monthDays(new Date(2026, 10, 1), 1)[0]).toEqual(new Date(2026, 9, 26));
  });

  it("shows a day's all-day events first, then three before saying how many more", () => {
    const list = onDay(
      [
        ev("lunch", at(12), at(13)),
        ev("standup", at(9), at(9, 15)),
        ev("trip", at(0, 0, 25), at(0, 0, 30), true),
        ev("late", at(22, 0, 26), at(1)),
        ev("tomorrow", at(9, 0, 28), at(10, 0, 28)),
      ],
      day,
    );
    expect(list.map((e) => e.id)).toEqual(["trip", "late", "standup", "lunch"]);
    expect(fitCell(list)).toEqual({ shown: list.slice(0, 3), more: 1 });
    expect(fitCell(list.slice(0, 3))).toEqual({ shown: list.slice(0, 3), more: 0 });
  });
});

describe("now and the popover", () => {
  it("puts now's line at the minute, counting days by the calendar", () => {
    expect(nowMinute(new Date(2026, 9, 27, 14, 30))).toBe(870);
    expect(minuteOf(new Date(2026, 9, 26, 23), day)).toBe(0);
    expect(minuteOf(new Date(2026, 9, 29), day)).toBe(1440);
    vi.stubEnv("TZ", "America/New_York");
    try {
      // The day New York's clocks go back is 25 hours long, but still one day.
      expect(daysBetween(new Date(2026, 10, 1), new Date(2026, 10, 2, 23))).toBe(1);
      expect(daysBetween(new Date(2026, 10, 2), new Date(2026, 9, 31, 1))).toBe(-2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("opens beside its event, on the other side or under it when there's no room", () => {
    const size = { width: 320, height: 300 };
    const view = { width: 1200, height: 800 };
    const rect = (left: number, right: number, top = 100, bottom = 140) => ({
      left,
      right,
      top,
      bottom,
    });
    expect(popoverAt(rect(100, 200), size, view)).toEqual({ top: 100, left: 208 });
    expect(popoverAt(rect(900, 1000), size, view)).toEqual({ top: 100, left: 572 });
    // Low on the screen, it rises to stay on it.
    expect(popoverAt(rect(100, 200, 700, 740), size, view)).toEqual({ top: 492, left: 208 });
    // A phone-wide event: under it.
    expect(popoverAt(rect(10, 370), size, { width: 380, height: 800 })).toEqual({
      top: 144,
      left: 10,
    });
  });
});
