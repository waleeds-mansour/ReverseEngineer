// Moving an event on Calendar's grid by hand, apart from what draws it: when a press becomes a drag,
// which day's column or cell the pointer is over, where a block lands as it's dragged up, down or
// across (by quarter hours from where it was, so 10:20 stays 10:20 on another day, and kept inside
// its day), how far its bottom edge stretches, how a month's chip keeps its time on another day,
// which events can be moved at all, what saving the move sends, and what a meeting asks first.

import { DAY_MINUTES, daysBetween, daysOn, minuteOf } from "./calLayout.ts";
import { date, time } from "./format.ts";
import type { CalEvent } from "./types.ts";

/** Times snap to a quarter of an hour. */
export const SNAP = 15;
/** How far a pointer moves before a press is a drag: less, and it's a click that opens the event. */
export const SLOP = 4;

/** An event's times while it's moved. */
export interface Span {
  start: Date;
  end: Date;
}

export const spanOf = (e: Pick<CalEvent, "startsAt" | "endsAt">): Span => ({
  start: new Date(e.startsAt),
  end: new Date(e.endsAt),
});

export const sameSpan = (a: Span, b: Span) =>
  a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();

export const snap = (minutes: number, step = SNAP) => Math.round(minutes / step) * step;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Whether the pointer has gone far enough from where it was pressed to be a drag. */
export const pastSlop = (dx: number, dy: number, slop = SLOP) => Math.hypot(dx, dy) > slop;

/** Pixels down the grid as minutes, `hour` px to an hour. */
export const toMinutes = (px: number, hour: number) => (px / hour) * 60;

/** Minutes as pixels down the grid. */
export const toPx = (minutes: number, hour: number) => (minutes / 60) * hour;

type Box = { left: number; right: number; top: number; bottom: number };

/** Which of the day columns (left to right) is under `x`: past either end, the one at that end. */
export function columnAt(x: number, cols: readonly Pick<Box, "left" | "right">[]): number {
  if (!cols.length) return -1;
  const i = cols.findIndex((c) => x >= c.left && x < c.right);
  if (i >= 0) return i;
  return x < cols[0]!.left ? 0 : cols.length - 1;
}

/** Which of a month's day cells is under the point, or -1 when none is. */
export const cellAt = (x: number, y: number, cells: readonly Box[]) =>
  cells.findIndex((c) => x >= c.left && x < c.right && y >= c.top && y < c.bottom);

/** `t` moved `days` days and `minutes` on by the wall clock, so across a clock change too. */
export const shifted = (t: Date, days: number, minutes = 0) =>
  new Date(
    t.getFullYear(),
    t.getMonth(),
    t.getDate() + days,
    t.getHours(),
    t.getMinutes() + minutes,
    t.getSeconds(),
    t.getMilliseconds(),
  );

/** Whether an event ends on `day`, so its block there has the bottom edge you drag to resize. */
export const endsOn = (e: Span, day: Date) => e.end > day && e.end <= daysOn(day, 1);

/**
 * A block picked up from `day`'s column, moved `dy` minutes down (up when less than 0) and onto
 * `to`'s column: by whole quarter hours from where it was (none for a nudge, so a sideways drag
 * keeps its minute), its length kept, and the part drawn in the column kept inside the day.
 * `shift` is how far its top moved, in minutes.
 */
export function moveBlock(e: Span, day: Date, dy: number, to: Date): Span & { shift: number } {
  const top = minuteOf(e.start, day);
  const bottom = Math.max(minuteOf(e.end, day), top);
  const shift = clamp(top + snap(dy), 0, DAY_MINUTES - (bottom - top)) - top;
  const start = shifted(e.start, daysBetween(day, to), shift);
  return { start, end: new Date(start.getTime() + (e.end.getTime() - e.start.getTime())), shift };
}

/**
 * A block's bottom edge dragged `dy` minutes: by whole quarter hours from where it was. Shrunk, it
 * stays a quarter hour long (or as short as it was); stretched, it stops at midnight.
 */
export function resizeBlock(e: Span, day: Date, dy: number): Span {
  const by = snap(dy);
  if (!by) return e;
  const top = minuteOf(e.start, day);
  const bottom = minuteOf(e.end, day);
  const next =
    by < 0
      ? Math.max(bottom + by, Math.min(top + SNAP, bottom))
      : Math.min(bottom + by, DAY_MINUTES);
  const end = shifted(e.end, 0, next - bottom);
  return { start: e.start, end: end > e.start ? end : e.end };
}

/** An event moved from one day to another, at the same time of day (a month's chip, a bar). */
export function moveDays(e: Span, from: Date, to: Date): Span {
  const n = daysBetween(from, to);
  return { start: shifted(e.start, n), end: shifted(e.end, n) };
}

/** Other people on an event: everyone but you. */
export const guestCount = (e: Pick<CalEvent, "attendees">) =>
  e.attendees.filter((a) => !a.self).length;

/**
 * Whether you can move an event by dragging it: on a calendar Nook can write to, not cancelled,
 * and, when it has guests, one you organize (only its organizer moves a meeting for everyone).
 */
export const canDrag = (e: Pick<CalEvent, "canWrite" | "status" | "attendees" | "selfOrganizer">) =>
  e.canWrite !== false && e.status !== "cancelled" && (e.selfOrganizer || !guestCount(e));

/** A day as an all-day event's date: "2026-10-27". */
export const dateOf = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * What saving a move sends: your own event changes straight away; a meeting with guests changes
 * through update_meeting, which tells them. An all-day event's times are dates.
 */
export function moveInput(e: Pick<CalEvent, "id" | "allDay" | "attendees">, to: Span) {
  const times = e.allDay
    ? { start: dateOf(to.start), end: dateOf(to.end) }
    : { start: to.start.toISOString(), end: to.end.toISOString() };
  return {
    action: guestCount(e) ? "calendar.update_meeting" : "calendar.update_event",
    input: { id: e.id, ...times },
  } as const;
}

/**
 * What dropping a meeting asks before its guests are told, naming it and where it goes: “Move
 * “Standup” to Thu, Oct 29, 10:30 a.m. and tell 3 guests?”
 */
export function moveQuestion(
  e: Pick<CalEvent, "title" | "allDay">,
  to: Span,
  guests: number,
  now?: Date,
): string {
  const title = e.title.length > 60 ? `${e.title.slice(0, 59).trimEnd()}…` : e.title;
  const on = now ? date(to.start, now) : date(to.start);
  const when = e.allDay ? on : `${on}, ${time(to.start)}`;
  return `Move “${title}” to ${when} and tell ${guests === 1 ? "1 guest" : `${guests} guests`}?`;
}
