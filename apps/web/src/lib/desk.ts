// Pip's desk on Today (jarvis.desk): the turn Pip is on now and what's waiting after it, and how a
// row says each in plain words: what it's about, how long it has been going, and until when.

import { startedBy, type TimelineTurn } from "./activity.ts";
import { time } from "./format.ts";

export interface DeskTurn extends TimelineTurn {
  /** Not before then: a retry waiting out its pause, say. */
  notBefore: string;
  /** When it's stopped if it hasn't finished; null until it starts. */
  deadline: string | null;
  /** You pressed Stop, and it's stopping. */
  stopping: boolean;
  /** It has used the browser, which gives it longer. */
  browsing: boolean;
}

export interface Desk {
  running: DeskTurn[];
  waiting: DeskTurn[];
  /** How many are waiting in all, listed or not. */
  waitingCount: number;
}

const MINUTE = 60_000;

/** What it's about: your words when you asked, or else what set it off ("Morning brief"). */
export const deskTitle = (t: DeskTurn): string =>
  t.asked ? `“${t.asked}”` : startedBy({ turn: t });

/** "Just started", "4 min so far", "1 h 5 min so far". */
function goingFor(t: DeskTurn, now: Date): string {
  const mins = t.startedAt ? Math.floor((now.getTime() - Date.parse(t.startedAt)) / MINUTE) : 0;
  if (mins < 1) return "Just started";
  if (mins < 60) return `${mins} min so far`;
  const rest = mins % 60;
  return `${Math.floor(mins / 60)} h${rest ? ` ${rest} min` : ""} so far`;
}

/**
 * The line under what Pip is working on: how long it has been going and until when it has. Past
 * that, Pip should already have stopped it, so it says so rather than give a time gone by.
 */
export function runningLine(t: DeskTurn, now: Date): string {
  if (t.stopping) return "Stopping…";
  const going = goingFor(t, now);
  if (!t.deadline) return going;
  const end = new Date(t.deadline);
  if (now.getTime() > end.getTime() + MINUTE) return `${going} · past its time`;
  return `${going} · has until ${time(end)}`;
}

/** The line under something waiting: since when, or when it can go if it has to wait. */
export function waitingLine(t: DeskTurn, now: Date): string {
  const after = new Date(t.notBefore);
  if (after.getTime() > now.getTime()) return `Waits until ${time(after)}`;
  return `In line since ${time(new Date(t.queuedAt))}`;
}
