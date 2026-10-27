// Calendar's layout math, apart from what draws it: where a timed event sits in its day's column
// and how events that overlap share the width (side by side, as Google Calendar packs them); which
// lane of the all-day row each all-day event runs along; the day weeks start on where you are; the
// six weeks a month shows and what fits in each day; where the line for now goes; and where an
// event's popover opens.

import type { CalEvent } from "./types.ts";

/** Minutes in a day by the clock on the wall: a day the clocks change in is drawn the same. */
export const DAY_MINUTES = 24 * 60;
const DAY_MS = 86_400_000;

type Timed = Pick<CalEvent, "startsAt" | "endsAt">;

/** The start of the day `n` days on from `day`'s: by the calendar, so across a clock change too. */
export const daysOn = (day: Date, n: number) =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);

/** Whole days from `a`'s day to `b`'s: 1 from today to tomorrow, whatever the clocks did. */
export const daysBetween = (a: Date, b: Date) =>
  Math.round((daysOn(b, 0).getTime() - daysOn(a, 0).getTime()) / DAY_MS);

/**
 * Whether an event goes in the row above the hours rather than in a day's column: an all-day one,
 * or one that runs a whole day or more, which would fill a column.
 */
export const inAllDayRow = (e: Timed & Pick<CalEvent, "allDay">) =>
  e.allDay || Date.parse(e.endsAt) - Date.parse(e.startsAt) >= DAY_MS;

/** Whether an event is on any of `day` (a day's start); one with no length, on its start's. */
export function touches(e: Timed, day: Date): boolean {
  const start = Date.parse(e.startsAt);
  const end = Date.parse(e.endsAt);
  const from = day.getTime();
  return start < daysOn(day, 1).getTime() && (end > from || start === from);
}

/** How far into `day` a time is, in minutes by the wall clock: 0 before it starts, 1440 after. */
export function minuteOf(t: Date, day: Date): number {
  if (t <= day) return 0;
  if (t >= daysOn(day, 1)) return DAY_MINUTES;
  return t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60;
}

/** Where now's line goes on today's column, in minutes into the day. */
export const nowMinute = (now: Date) => minuteOf(now, daysOn(now, 0));

/** One event in its day's column: from `top` to `bottom` in minutes, in column `col` of `cols`. */
export interface Placed<T> {
  item: T;
  top: number;
  bottom: number;
  col: number;
  cols: number;
  /** How many columns it takes: more than one when those to its right are free alongside it. */
  span: number;
}

/**
 * Packs events that overlap side by side. Events that overlap one another, even through a third,
 * are a cluster, and every event in it is as narrow as the cluster's widest moment needs; each
 * takes the leftmost column free when it starts, then stretches right over columns free beside it.
 */
export function pack<T>(items: readonly { item: T; top: number; bottom: number }[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let ends: number[] = [];
  let clusterEnd = Number.NEGATIVE_INFINITY;
  const close = () => {
    for (const p of cluster) {
      p.cols = ends.length;
      for (let c = p.col + 1; c < ends.length; c++) {
        if (cluster.some((q) => q.col === c && q.top < p.bottom && q.bottom > p.top)) break;
        p.span++;
      }
    }
    out.push(...cluster);
    cluster = [];
    ends = [];
  };
  for (const it of sorted) {
    if (it.top >= clusterEnd) close();
    let col = ends.findIndex((end) => end <= it.top);
    if (col < 0) col = ends.push(it.bottom) - 1;
    else ends[col] = it.bottom;
    cluster.push({ ...it, col, cols: 1, span: 1 });
    clusterEnd = Math.max(clusterEnd, it.bottom);
  }
  close();
  return out;
}

/**
 * A day's timed events, placed in its column. One shorter than `least` minutes is drawn that tall,
 * so it can be read and clicked, and packs as that tall. One across midnight is cut to the day.
 */
export function dayColumn<T extends Timed>(events: readonly T[], day: Date, least = 20) {
  const items = events
    .filter((e) => touches(e, day))
    .map((e) => {
      const top = Math.min(minuteOf(new Date(e.startsAt), day), DAY_MINUTES - least);
      const end = minuteOf(new Date(e.endsAt), day);
      return { item: e, top, bottom: Math.max(end, top + least) };
    });
  return pack(items);
}

/** An all-day event in the row above the hours: from day `col`, `span` days long, in `lane`. */
export interface Lane<T> {
  item: T;
  col: number;
  span: number;
  lane: number;
  /** It began before the first day shown, or goes on past the last: that end is cut square. */
  before: boolean;
  after: boolean;
}

/** All-day events in lanes across `days`, each in the highest lane free for all its days. */
export function allDayLanes<T extends Timed>(events: readonly T[], days: readonly Date[]) {
  const runs: Omit<Lane<T>, "lane">[] = [];
  for (const e of events) {
    const on = days.map((d) => touches(e, d));
    const col = on.indexOf(true);
    if (col < 0) continue;
    const last = on.lastIndexOf(true);
    runs.push({
      item: e,
      col,
      span: last - col + 1,
      before: Date.parse(e.startsAt) < days[0]!.getTime(),
      after: Date.parse(e.endsAt) > daysOn(days[days.length - 1]!, 1).getTime(),
    });
  }
  runs.sort((a, b) => a.col - b.col || b.span - a.span);
  // The last day each lane is taken to.
  const taken: number[] = [];
  return runs.map((r): Lane<T> => {
    let lane = taken.findIndex((last) => last < r.col);
    if (lane < 0) lane = taken.push(0) - 1;
    taken[lane] = r.col + r.span - 1;
    return { ...r, lane };
  });
}

/** A locale's week, as Intl tells it: getWeekInfo() is the newer name of the weekInfo getter. */
type WeekInfo = { firstDay?: number };

/**
 * The day weeks start on in `locale`, counted as Date.getDay() counts (0 Sunday, 1 Monday … 6
 * Saturday): Monday in most of the world, Sunday in America. Sunday when the browser can't say.
 */
export function firstWeekday(
  locale = typeof navigator === "undefined" ? "en-US" : navigator.language,
): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => WeekInfo;
      weekInfo?: WeekInfo;
    };
    // Intl counts 1 Monday … 7 Sunday.
    const first = (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay;
    return typeof first === "number" && first >= 1 && first <= 7 ? first % 7 : 0;
  } catch {
    return 0;
  }
}

/** The day this browser's weeks start on (firstWeekday), for the week and month grids alike. */
export const WEEK_STARTS = firstWeekday();

/** The start of the week `day` is in, for weeks that start on `first` (0 Sunday … 6 Saturday). */
export const weekStart = (day: Date, first = WEEK_STARTS) =>
  daysOn(day, -((day.getDay() - first + 7) % 7));

/** The 42 days a month shows: six weeks, from the start of the week its first day is in. */
export function monthDays(month: Date, first = WEEK_STARTS): Date[] {
  const start = weekStart(new Date(month.getFullYear(), month.getMonth(), 1), first);
  return Array.from({ length: 42 }, (_, i) => daysOn(start, i));
}

/** A day's events for a month's cell: all-day ones first, then by when they start. */
export function onDay<T extends Timed & Pick<CalEvent, "allDay">>(events: readonly T[], day: Date) {
  return events
    .filter((e) => touches(e, day))
    .sort(
      (a, b) =>
        Number(inAllDayRow(b)) - Number(inAllDayRow(a)) ||
        Date.parse(a.startsAt) - Date.parse(b.startsAt),
    );
}

/** What a month's cell has room for: up to `max` events, and how many more there are. */
export function fitCell<T>(list: readonly T[], max = 3): { shown: T[]; more: number } {
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

/**
 * Where a popover `size` big opens beside `at` (an event on screen): to its right, else its left,
 * else under it; always `gap` inside the window.
 */
export function popoverAt(
  at: { top: number; left: number; right: number; bottom: number },
  size: { width: number; height: number },
  view: { width: number; height: number },
  gap = 8,
): { top: number; left: number } {
  const fit = (n: number, room: number) => Math.max(gap, Math.min(n, room - gap));
  const top = fit(at.top, view.height - size.height);
  if (at.right + gap + size.width <= view.width - gap) return { top, left: at.right + gap };
  if (at.left - gap - size.width >= gap) return { top, left: at.left - gap - size.width };
  const below = at.bottom + 4 + size.height <= view.height - gap;
  return {
    top: below ? at.bottom + 4 : fit(at.top - 4 - size.height, view.height - size.height),
    left: fit(at.left, view.width - size.width),
  };
}
