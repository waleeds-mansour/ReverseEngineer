// Calendar's days: which ones a view shows (a day, a week, or a month's six weeks, its weeks
// starting on the day they do where you are), how far on from today's it is, and what its header
// calls it; and a week's events by day, for the agenda. What's shown moves on when the day turns,
// not each minute, and the agenda keys each day's section by its date, so neither the minute moving
// on nor the week read again unchanged draws a day or an event again. What's chosen in one stays
// chosen: a recurring invite's "This time only", the focus.

import { type Accessor, createMemo } from "solid-js";
import { daysBetween, daysOn, monthDays, WEEK_STARTS, weekStart } from "./calLayout.ts";
import { createToday } from "./clock.ts";
import { isPlan } from "./today.ts";
import type { CalEvent } from "./types.ts";

/** How far ahead Hearth keeps your calendar (calendar/sync.ts SYNC_AHEAD_DAYS). */
export const SYNCED_DAYS_AHEAD = 60;

/** How far back Hearth keeps your calendar (calendar/sync.ts SYNC_BACK_DAYS). */
export const SYNCED_DAYS_BACK = 7;

/** The first day Hearth doesn't have: the start of the day `SYNCED_DAYS_AHEAD` days on. */
export const syncedUntil = (today: Date) => daysOn(today, SYNCED_DAYS_AHEAD);

/** The first day Hearth has: the start of the day `SYNCED_DAYS_BACK` days back. */
export const syncedFrom = (today: Date) => daysOn(today, -SYNCED_DAYS_BACK);

/** The start of the day `weeks` weeks on from `day`: by the calendar, so a week the clocks
 *  change in still starts at midnight, not an hour either side of it. */
export const weeksOn = (day: Date, weeks: number) => daysOn(day, 7 * weeks);

/** Calendar's three views. Below a phone's width each is a list (the agenda) instead of a grid. */
export type CalView = "day" | "week" | "month";

/** What a view shows: its days, the month it's of, and the times read for it. */
export interface Shown {
  days: Date[];
  /** The first of the month a month view is of. */
  month?: Date;
  /** The first day shown, and the start of the day after the last. */
  from: Date;
  end: Date;
  /** Read up to here, which can be past `end` (see shown). */
  to: Date;
}

/**
 * What `view` shows `offset` days, weeks or months on from `today` (the start of today), its weeks
 * starting on `first` (0 Sunday … 6 Saturday). A note about nothing on is about the 7 days from a
 * day (emptyNoteFrom), so those are read too: a day reads the week from it, and this week reads on
 * to a week from today.
 */
export function shown(view: CalView, today: Date, offset: number, first = WEEK_STARTS): Shown {
  if (view === "day") {
    const day = daysOn(today, offset);
    return { days: [day], from: day, end: daysOn(day, 1), to: weeksOn(day, 1) };
  }
  if (view === "week") {
    const from = weeksOn(weekStart(today, first), offset);
    const end = weeksOn(from, 1);
    const days = Array.from({ length: 7 }, (_, i) => daysOn(from, i));
    return { days, from, end, to: today >= from && today < end ? weeksOn(today, 1) : end };
  }
  const month = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const days = monthDays(month, first);
  const end = daysOn(days[days.length - 1]!, 1);
  return { days, month, from: days[0]!, end, to: end };
}

/** What a view shows, moving on as the day turns (at midnight, not each minute). */
export function createShown(
  view: Accessor<CalView>,
  offset: Accessor<number>,
  first = WEEK_STARTS,
): Accessor<Shown> {
  const today = createToday();
  return createMemo(() => shown(view(), new Date(today()), offset(), first));
}

/** The day a view is about, kept when you switch: today in this week or month, else its first. */
export function focusOf(view: CalView, today: Date, offset: number, first = WEEK_STARTS): Date {
  if (view === "day") return daysOn(today, offset);
  if (offset === 0) return today;
  if (view === "week") return weeksOn(weekStart(today, first), offset);
  return new Date(today.getFullYear(), today.getMonth() + offset, 1);
}

/** How far on from today's `view` is, for the one with `day` in it. */
export function offsetFor(view: CalView, today: Date, day: Date, first = WEEK_STARTS): number {
  if (view === "day") return daysBetween(today, day);
  if (view === "week") return Math.floor(daysBetween(weekStart(today, first), day) / 7);
  return (day.getFullYear() - today.getFullYear()) * 12 + day.getMonth() - today.getMonth();
}

/**
 * The 7 days a note about nothing on is about (lib/emptyWeek.ts), out of what was read: from today
 * when they were all read; else the first 7 Nook keeps, in a month; else from the first day read.
 */
export function emptyNoteFrom(s: Shown, today: Date): Date {
  const last = weeksOn(s.to, -1);
  const fits = (d: Date) => d >= s.from && d <= last;
  const since = syncedFrom(today);
  return fits(today) ? today : fits(since) ? since : s.from;
}

const say = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", o);

/** What's shown, in words: "Tuesday, October 27, 2026", "Oct 26 – Nov 1, 2026", "October 2026". */
export function rangeLabel(view: CalView, s: Shown): string {
  if (s.month) return say(s.month, { month: "long", year: "numeric" });
  const first = s.days[0]!;
  if (view === "day")
    return say(first, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const last = s.days[s.days.length - 1]!;
  const year = first.getFullYear() !== last.getFullYear();
  const from = say(first, { month: "short", day: "numeric", ...(year ? { year: "numeric" } : {}) });
  const to =
    first.getMonth() === last.getMonth() && !year
      ? String(last.getDate())
      : say(last, { month: "short", day: "numeric" });
  return `${from} – ${to}, ${last.getFullYear()}`;
}

/**
 * The week's events by day, in their order: its days (each a `toDateString()`, which a `<For>`
 * keeps a section by) and each day's events. One that began before the week is on its first day.
 */
export function byDay(events: Accessor<readonly CalEvent[] | undefined>, from: Accessor<Date>) {
  const groups = createMemo(() => {
    const days = new Map<string, CalEvent[]>();
    for (const e of events() ?? []) {
      if (!isPlan(e)) continue;
      const start = new Date(e.startsAt);
      const key = (start < from() ? from() : start).toDateString();
      const list = days.get(key);
      if (list) list.push(e);
      else days.set(key, [e]);
    }
    return days;
  });
  return {
    days: () => [...groups().keys()],
    on: (day: string) => groups().get(day) ?? [],
  };
}
