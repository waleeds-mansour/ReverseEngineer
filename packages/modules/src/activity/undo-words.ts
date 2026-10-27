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
  purged: "Gone for good: Gmail empties its trash after 30 days",
  guests: "It has guests now, so Undo would tell them",
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

/** What Pip did to a conversation's flags (mail/flags.ts), by the change it made. */
export type FlagOp = "archive" | "trash" | "unarchive" | "read" | "unread" | "star" | "unstar";

/** A conversation's subject, or what's said for one without. */
const subject = (s: string) => s.trim() || "(no subject)";

type Words = [did: string, undo: (q: string) => string, alt?: (q: string) => string];
const FLAG_WORDS: Record<FlagOp, Words> = {
  archive: ["Archived", (q) => `put ${q} back in the inbox`],
  trash: [
    "Moved to the trash",
    (q) => `bring ${q} back from the trash`,
    (q) => `bring ${q} back to the inbox`,
  ],
  unarchive: [
    "Moved back to the inbox",
    (q) => `take ${q} out of the inbox again`,
    (q) => `put ${q} back in the trash`,
  ],
  read: ["Marked read", (q) => `mark ${q} unread again`],
  unread: ["Marked unread", (q) => `mark ${q} read again`],
  star: ["Starred", (q) => `unstar ${q}`],
  unstar: ["Unstarred", (q) => `star ${q} again`],
};

/**
 * `alt`: a trash whose Undo puts it back in the inbox too, or moving back to the inbox one that
 * was in the trash, whose Undo puts it back there.
 */
export function flagWords(op: FlagOp, title: string, alt = false) {
  const [did, undo, other] = FLAG_WORDS[op];
  const q = quoted(subject(title));
  return { did: `${did}: ${subject(title)}`, label: `Undo: ${(alt && other ? other : undo)(q)}` };
}

/** A conversation moved to another bundle (`to`), or let the rules sort it again (null). */
export function bundleWords(title: string, to: string | null, from: string) {
  return {
    did: to
      ? `Moved to ${to}: ${subject(title)}`
      : `Let the rules sort it again: ${subject(title)}`,
    label: `Undo: move ${quoted(subject(title))} back to ${from}`,
  };
}

/** Said it needs no reply (`said`), or that it needs one after all. */
export function noReplyWords(title: string, said: boolean) {
  const q = quoted(subject(title));
  return said
    ? {
        did: `Said it needs no reply: ${subject(title)}`,
        label: `Undo: put ${q} back as needing your reply`,
      }
    : {
        did: `Said it needs a reply: ${subject(title)}`,
        label: `Undo: say ${q} needs no reply again`,
      };
}

/** Many conversations done the same way in one go, by what was done (undo-mail.ts's op). */
const MANY: Record<string, [did: (n: string) => string, undo: (them: string) => string]> = {
  archive: [(n) => `Archived ${n}`, (t) => `put ${t} back in the inbox`],
  trash: [(n) => `Moved ${n} to the trash`, (t) => `bring ${t} back from the trash`],
  unarchive: [(n) => `Moved ${n} back to the inbox`, (t) => `take ${t} out of the inbox again`],
  read: [(n) => `Marked ${n} read`, (t) => `mark ${t} unread again`],
  unread: [(n) => `Marked ${n} unread`, (t) => `mark ${t} read again`],
  star: [(n) => `Starred ${n}`, (t) => `unstar ${t}`],
  unstar: [(n) => `Unstarred ${n}`, (t) => `star ${t} again`],
  no_reply: [(n) => `Said ${n} need no reply`, (t) => `put ${t} back as needing your reply`],
  needs_reply: [(n) => `Said ${n} need a reply`, (t) => `say ${t} need no reply again`],
};

/**
 * One line for `n` conversations done the same way; `open` of them are still as Pip left them,
 * which is all Undo puts back. A bundle's op names where they went ("bundle:Updates").
 */
export function manyWords(op: string, n: number, open: number) {
  const all = `${n} conversations`;
  const them = open === n || open === 0 ? `the ${all}` : `${open} of the ${all}`;
  const left = n - open;
  const rest =
    open === 0 || left === 0
      ? ""
      : left === 1
        ? "; 1 changed since stays as it is"
        : `; ${left} changed since stay as they are`;
  const to = op.startsWith("bundle:") ? op.slice("bundle:".length) : null;
  const [did, undo] =
    to === null
      ? (MANY[op] ?? [(x: string) => `Changed ${x}`, (t: string) => `put ${t} back`])
      : [
          (x: string) => (to ? `Moved ${x} to ${to}` : `Let the rules sort ${x} again`),
          (t: string) => `move ${t} back where they were`,
        ];
  return { did: did(all), label: `Undo: ${undo(them)}${rest}` };
}

const LANE: Record<string, string> = { signal: "Signal", noise: "Noise" };

/**
 * A sender sent to a lane: what their rule was (`was`), how many conversations its Undo moves back
 * (`moving`), and how many it moved (`moved`): past MOVED_BACK, Undo moves back only the first.
 */
export function laneWords(
  pattern: string,
  lane: string,
  was: string | null,
  moving: number,
  moved = moving,
) {
  const back = LANE[lane === "noise" ? "signal" : "noise"];
  const them =
    moved > moving
      ? `the first ${moving} of its ${moved} conversations`
      : moving === 1
        ? "its conversation"
        : `its ${moving} conversations`;
  const q = quoted(pattern);
  return {
    did: `Sent mail from ${pattern} to ${LANE[lane]}`,
    label:
      was === lane
        ? `Undo: move ${them.replace("its", "the")} from ${q} back to ${back}`
        : was
          ? `Undo: send mail from ${q} back to ${LANE[was]}${moved > moving ? ` and move ${them} back` : ""}`
          : `Undo: forget the ${LANE[lane]} rule for ${q}${moving ? ` and move ${them} back to ${back}` : ""}`,
  };
}

export function discardWords(title: string) {
  return {
    did: `Threw away a draft: ${subject(title)}`,
    label: `Undo: bring back the draft ${quoted(subject(title))}`,
  };
}

/** An event Pip put on your calendar on its own, or a task's block of time (`block`). */
export function addedWords(title: string, block: boolean) {
  return {
    did: SAID.event!(title),
    label: `Undo: take ${block ? "the block " : ""}${quoted(title)} off your calendar`,
  };
}
