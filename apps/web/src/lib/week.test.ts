// Calendar's days: what each view shows and calls it, weeks starting on Sunday or on Monday as
// the locale has it, keeping the day you were on when switching views; and the agenda keeps each
// day's section, and each event's row, as the days turn and when the week is read again unchanged:
// a recurring invite's "This time only" stays chosen until you answer, rather than going back to
// "Every time" and declining the whole series.
import { createRoot, createSignal, mapArray } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalEvent } from "./types.ts";
import {
  byDay,
  type CalView,
  createShown,
  emptyNoteFrom,
  focusOf,
  offsetFor,
  rangeLabel,
  shown,
  syncedUntil,
  weeksOn,
} from "./week.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

const event = (id: string, at: Date) => ({ id, startsAt: at.toISOString() }) as CalEvent;
/** Weeks that start on Sunday (America) and on Monday (most of the world), as getDay counts. */
const SUNDAY = 0;
const MONDAY = 1;

describe("the week, by day", () => {
  it("leaves out where you work and birthdays, and knows how far ahead Hearth keeps", () => {
    createRoot((dispose) => {
      const day = new Date(2026, 9, 7);
      const week = byDay(
        () => [
          { ...event("office", day), kind: "workingLocation" },
          { ...event("sam", day), kind: "birthday" },
          { ...event("lunch", day), kind: "default" },
        ],
        () => day,
      );
      expect(week.on(day.toDateString()).map((e) => e.id)).toEqual(["lunch"]);
      dispose();
    });
    expect(syncedUntil(new Date(2026, 9, 7, 15))).toEqual(new Date(2026, 11, 6));
  });

  afterEach(() => vi.useRealTimers());

  // One run: the clock starts ticking once, with the first thing that reads it.
  it("keeps a day, its rows and what's chosen in them as the days turn", () => {
    vi.useFakeTimers();
    // A Wednesday, in a week that starts on Sunday the 4th.
    vi.setSystemTime(new Date(2026, 9, 7, 9, 0, 30));
    createRoot((dispose) => {
      const [events, setEvents] = createSignal([
        event("late", new Date(2026, 9, 3, 22)),
        event("lunch", new Date(2026, 9, 4, 12)),
        event("review", new Date(2026, 9, 8, 14)),
      ]);
      const [offset, setOffset] = createSignal(0);
      const view = createShown(() => "week", offset, SUNDAY);
      const from = () => view().from;
      const week = byDay(events, from);
      expect(from()).toEqual(new Date(2026, 9, 4));
      // Where weeks start on Monday, this one starts on the 5th.
      expect(createShown(() => "week", offset, MONDAY)().from).toEqual(new Date(2026, 9, 5));
      // Begun the day before the week: on its first day.
      expect(week.on(new Date(2026, 9, 4).toDateString()).map((e) => e.id)).toEqual([
        "late",
        "lunch",
      ]);
      // As the agenda's <For>s draw them: a section a day, a row an event, each made once.
      const sections = mapArray(week.days, (day) => {
        // The invite's answer, as InviteAnswers keeps it: "Every time" until you pick.
        const [scope, setScope] = createSignal("all");
        const rows = mapArray(
          () => week.on(day),
          (e) => ({ e }),
        );
        return { day, scope, setScope, rows };
      });
      const first = sections()[0]!;
      const row = first.rows()[1]!;
      first.setScope("one");
      const same = () => {
        expect(sections()[0]).toBe(first);
        expect(first.rows()[1]).toBe(row);
        expect(first.scope()).toBe("one");
      };
      vi.advanceTimersByTime(60_000);
      same();
      // Read again, nothing changed (keepUnchanged keeps the same events): still the same.
      setEvents([...events()]);
      same();
      // Past midnight it's still the same week, drawn as it was.
      vi.advanceTimersByTime(15 * 3_600_000);
      expect(from()).toEqual(new Date(2026, 9, 4));
      same();
      // On Sunday the week moves on; a week on, a week on from that.
      vi.advanceTimersByTime(3 * 86_400_000);
      expect(from()).toEqual(new Date(2026, 9, 11));
      setOffset(1);
      expect(from()).toEqual(new Date(2026, 9, 18));
      dispose();
    });
  });

  it("starts a week the clocks change in at midnight", () => {
    // New York's clocks go back an hour on 1 November 2026: that week is 7 days and an hour long.
    vi.stubEnv("TZ", "America/New_York");
    try {
      expect(weeksOn(new Date(2026, 9, 29), 1)).toEqual(new Date(2026, 10, 5));
      expect(weeksOn(new Date(2026, 10, 5), -1)).toEqual(new Date(2026, 9, 29));
      expect(weeksOn(new Date(2026, 9, 29, 15), 0)).toEqual(new Date(2026, 9, 29));
      const days = shown("week", new Date(2026, 10, 3), 0, SUNDAY).days;
      expect(days.map((d) => d.getHours())).toEqual([0, 0, 0, 0, 0, 0, 0]);
      expect([days[0], days[6]]).toEqual([new Date(2026, 10, 1), new Date(2026, 10, 7)]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("what each view shows", () => {
  // A Tuesday. Its week starts on Sunday the 25th, or on Monday the 26th.
  const today = new Date(2026, 9, 27);
  const span = (s: { from: Date; end: Date; to: Date }) => [s.from, s.end, s.to];

  it("shows a day, a week, or a month's six weeks, from the day weeks start on", () => {
    const day = shown("day", today, 2);
    expect(day.days).toEqual([new Date(2026, 9, 29)]);
    // A day reads the week from it, for what a note about nothing on would say.
    expect(span(day)).toEqual([
      new Date(2026, 9, 29),
      new Date(2026, 9, 30),
      new Date(2026, 10, 5),
    ]);

    // This week reads on to a week from today; another reads its own days.
    expect(span(shown("week", today, 0, SUNDAY))).toEqual([
      new Date(2026, 9, 25),
      new Date(2026, 10, 1),
      new Date(2026, 10, 3),
    ]);
    expect(span(shown("week", today, 0, MONDAY))).toEqual([
      new Date(2026, 9, 26),
      new Date(2026, 10, 2),
      new Date(2026, 10, 3),
    ]);
    const before = shown("week", today, -1, MONDAY);
    expect(before.days).toHaveLength(7);
    expect(span(before)).toEqual([
      new Date(2026, 9, 19),
      new Date(2026, 9, 26),
      new Date(2026, 9, 26),
    ]);

    // November 2026 starts on a Sunday: a Sunday grid starts on it, a Monday one the week before.
    const sunday = shown("month", today, 1, SUNDAY);
    expect(sunday.month).toEqual(new Date(2026, 10, 1));
    expect(sunday.days).toHaveLength(42);
    expect([sunday.from, sunday.to]).toEqual([new Date(2026, 10, 1), new Date(2026, 11, 13)]);
    const monday = shown("month", today, 1, MONDAY);
    expect([monday.from, monday.to]).toEqual([new Date(2026, 9, 26), new Date(2026, 11, 7)]);
  });

  it("keeps the day you were on when you switch views", () => {
    const go = (from: CalView, offset: number, to: CalView, first = SUNDAY) =>
      offsetFor(to, today, focusOf(from, today, offset, first), first);
    // This week is about today; two weeks on, about its first day, Sunday Nov 8.
    expect(go("week", 0, "day")).toBe(0);
    expect(go("week", 2, "day")).toBe(12);
    expect(go("day", 13, "week")).toBe(2);
    expect(go("day", -1, "week")).toBe(0);
    expect(go("day", -3, "week")).toBe(-1);
    // Where weeks start on Monday, Sunday the 25th is last week's, and next week starts Nov 2.
    expect(go("day", -1, "week", MONDAY)).toBe(0);
    expect(go("day", -2, "week", MONDAY)).toBe(-1);
    expect(go("week", 1, "day", MONDAY)).toBe(6);
    // Next week is November's; November's month view opens on its first week.
    expect(go("week", 1, "month")).toBe(1);
    expect(go("month", 1, "week")).toBe(1);
    expect(go("month", 2, "week")).toBe(5);
    expect(go("month", 2, "day")).toBe(35);
    // This month, in another view, is about today.
    expect(go("month", 0, "day")).toBe(0);
    expect(offsetFor("month", today, new Date(2027, 0, 4))).toBe(3);
  });

  it("says nothing's on about 7 days that were read", () => {
    expect(emptyNoteFrom(shown("day", today, 3), today)).toEqual(new Date(2026, 9, 30));
    // This week: the 7 days from today, which it read. Last week: its first day.
    expect(emptyNoteFrom(shown("week", today, 0, MONDAY), today)).toEqual(today);
    expect(emptyNoteFrom(shown("week", today, -1, SUNDAY), today)).toEqual(new Date(2026, 9, 18));
    // This month: this week. Last month: the first week Nook keeps. Next: its grid's first.
    expect(emptyNoteFrom(shown("month", today, 0), today)).toEqual(today);
    const nov5 = new Date(2026, 10, 5);
    expect(emptyNoteFrom(shown("month", nov5, -1, SUNDAY), nov5)).toEqual(new Date(2026, 9, 29));
    expect(emptyNoteFrom(shown("month", today, 2, SUNDAY), today)).toEqual(new Date(2026, 10, 29));
  });

  it("calls what's shown what a calendar would", () => {
    expect(rangeLabel("day", shown("day", today, 0))).toBe("Tuesday, October 27, 2026");
    expect(rangeLabel("week", shown("week", today, 0, SUNDAY))).toBe("Oct 25 – 31, 2026");
    expect(rangeLabel("week", shown("week", today, 0, MONDAY))).toBe("Oct 26 – Nov 1, 2026");
    expect(rangeLabel("week", shown("week", new Date(2026, 11, 29), 0, SUNDAY))).toBe(
      "Dec 27, 2026 – Jan 2, 2027",
    );
    expect(rangeLabel("month", shown("month", today, 0))).toBe("October 2026");
  });
});
