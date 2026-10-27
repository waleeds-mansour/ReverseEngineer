// What Pip did and what its Undo puts back, in words: one line for what it did, in the words
// Today uses for it (assistant/did.ts), and the button's, which say exactly what pressing it does.
// Why it can't be undone any more is said here too, so every screen says it the same way.
import { formatTime, localDate, PRINCIPAL } from "@hearth/core";
import type { NotificationUndo } from "@hearth/db";
import { SAID } from "../assistant/did.ts";

/** Why an Undo is greyed. */
export const WHY_NOT = {
  undone: "Undone",
  old: "Too old to undo here",
  oldTrash: "Too old to undo here: restore it from the Trash",
  gone: "It's gone",
  inTrash: "It's in the trash",
  back: "It's back from the trash",
  youChanged: "You've changed it since",
  changed: "It's changed since",
  offCalendar: "It's not on your calendar any more",
  backOnCalendar: "It's back on your calendar",
  answered: "You've answered it yourself since",
} as const;

/** Said beside an Undo that tells someone else, so it shows on a phone too. */
export const ORGANIZER_SEES = "Its organizer will see";

/** A title on one line and quoted, so it can't pass for the button's own words. */
export function quoted(title: string | null | undefined): string {
  const t = (title ?? "")
    .replace(/[\p{Cc}\p{Cf}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return t ? `"${t}"` : "it";
}

/** What Pip makes that Today doesn't list, by what Nook calls it. */
const MADE: Record<string, (title: string) => string> = {
  canvas: (t) => `Made a board: ${t}`,
  spreadsheet: (t) => `Made a sheet: ${t}`,
  person: (t) => `Added a person: ${t}`,
  company: (t) => `Added a company: ${t}`,
  meeting: (t) => `Started a meeting: ${t}`,
  page_watch: (t) => `Started watching a page: ${t}`,
  memory_note: (t) => `Remembered: ${t}`,
  comment: () => "Left a comment",
};

/** What others put under a record Pip made, which goes to the trash with it. */
export interface Under {
  yours: number;
  others: number;
}

const things = (n: number) => (n === 1 ? "1 thing" : `${n} things`);

export function madeWords(type: string, title: string, under: Under = { yours: 0, others: 0 }) {
  const did = (SAID[type] ?? MADE[type] ?? ((t: string) => `Made: ${t}`))(title);
  const n = under.yours + under.others;
  const also = !n
    ? ""
    : under.others
      ? `, with the ${things(n)} added under it since`
      : `, with the ${things(n)} you added under it`;
  return { did, label: `Undo: move ${quoted(title)} to the trash${also}` };
}

export function trashedWords(title: string) {
  return {
    did: `Moved to the trash: ${title}`,
    label: `Undo: bring ${quoted(title)} back from the trash`,
  };
}

const STATUS: Record<string, string> = {
  not_started: "not started",
  in_progress: "in progress",
  in_review: "in review",
  completed: "done",
  canceled: "canceled",
};
const status = (s: unknown) => STATUS[String(s)] ?? String(s);

export function statusWords(title: string, from: unknown, to: unknown) {
  return {
    did: `Marked ${status(to)}: ${title}`,
    label: `Undo: put ${quoted(title)} back to ${status(from)}`,
  };
}

/** A due date as a day: "Tue 2026-10-13". */
function day(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(d);
  return `${weekday} ${localDate(d, timeZone)}`;
}

/** A due date and whether it's a whole day; unknown for one changed before Nook kept that. */
export interface Due {
  at: string | null;
  isDate?: boolean;
}

export function dueWords(title: string, from: Due, to: Due, timeZone: string) {
  // The day, and its time too when only the time changed: the day alone would read the same.
  const sameDay = !!from.at && !!to.at && day(from.at, timeZone) === day(to.at, timeZone);
  const say = (d: Due & { at: string }) =>
    sameDay && d.isDate !== true
      ? `${day(d.at, timeZone)}, ${formatTime(new Date(d.at), timeZone)}`
      : day(d.at, timeZone);
  return {
    did: to.at
      ? `Set the due date to ${say({ ...to, at: to.at })}: ${title}`
      : `Took the due date off: ${title}`,
    label: from.at
      ? `Undo: put ${quoted(title)} back to due ${say({ ...from, at: from.at })}`
      : `Undo: take the due date off ${quoted(title)}`,
  };
}

const WHO: Record<string, string> = { [PRINCIPAL.owner]: "you", [PRINCIPAL.jarvis]: "Pip" };

export function assignedWords(title: string, from: string | null, to: string | null) {
  return {
    did: to ? `Gave it to ${WHO[to] ?? to}: ${title}` : `Unassigned: ${title}`,
    label: from
      ? `Undo: give ${quoted(title)} back to ${WHO[from] ?? from}`
      : `Undo: unassign ${quoted(title)}`,
  };
}

export function memoryWords(title: string) {
  return {
    did: `Changed what it remembers: ${title}`,
    label: `Undo: put what Pip remembers as ${quoted(title)} back as it was`,
  };
}

/**
 * The calendar's own Undo (calendar/undo.ts), as Inbox says it (web lib/undo.ts). Taking back a
 * yes changes your answer at Google, which its organizer sees, so the button says so.
 */
export function calendarLabel(u: NotificationUndo, eventTitle: string | null): string {
  const title = eventTitle === null ? "the event" : quoted(eventTitle);
  switch (u.kind) {
    case "unaccept":
      return `Undo: take back the yes to ${u.before.scope === "all" ? "every " : ""}${title}; its organizer will see`;
    case "unmove":
      return `Undo: move ${title} back to ${u.before.when}`;
    case "unremove":
      return `Undo: put ${quoted(u.before.title)} back on ${u.before.when}`;
  }
}
