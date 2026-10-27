// Today as Pip's feed: what Pip says at the top of it in its own words, how the day looks in a
// word, what Pip told you that you haven't seen, and what it did since yesterday with which of it
// it can take back. Apart from how it looks, so each is tested on its own (pipFeed.test.ts).

import { time } from "./format.ts";
import type { CalEvent, Did, InboxRow } from "./types.ts";

/** A sentence of Pip's line, and the section of Today it's about. */
export interface PipSays {
  text: string;
  /** The id of the section it takes you to. */
  to: string;
}

/** "One thing" or "3 things": a count said the way Pip would start a sentence with it. */
const counted = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** Where today's meetings stand, in one sentence: what's on now, what's next, or that it's over. */
function meetingsSaid(meetings: readonly Pick<CalEvent, "startsAt" | "endsAt">[], now: Date) {
  const at = now.getTime();
  if (meetings.length === 0) return "No meetings today.";
  const ahead = meetings.filter((m) => Date.parse(m.startsAt) > at);
  const on = meetings.some((m) => Date.parse(m.startsAt) <= at && Date.parse(m.endsAt) > at);
  if (on)
    return ahead.length === 0
      ? "You're in your last meeting of the day."
      : `You're in a meeting now, and ${ahead.length === 1 ? "one" : ahead.length} more after it.`;
  const next = ahead[0];
  if (!next)
    return meetings.length === 1
      ? "Your one meeting is over."
      : "Your meetings are over for today.";
  const left = ahead.length < meetings.length ? " left" : "";
  // "2 p.m." ends the sentence itself.
  const when = time(new Date(next.startsAt)).replace(/\.$/, "");
  return ahead.length === 1
    ? `One meeting${left}, at ${when}.`
    : `${ahead.length} meetings${left}, the next at ${when}.`;
}

/**
 * What Pip says under the greeting, a sentence a thing: "One meeting, at 2 p.m. 3 things need your
 * yes. I wrote 2 drafts, ready to send. One email is waiting on your reply. 4 tasks are due." A
 * count still being read (null) is left out, and "Nothing needs you." waits for both it's made of.
 */
export function pipLine(n: {
  approvals: number | null;
  ready: number | null;
  /** Today's timed meetings, in order. */
  meetings: readonly Pick<CalEvent, "startsAt" | "endsAt">[];
  /** Conversations waiting on your reply with no reply drafted. */
  owed: number;
  due: number;
  now: Date;
}): PipSays[] {
  const said: PipSays[] = [{ text: meetingsSaid(n.meetings, n.now), to: "today-day" }];
  if (n.approvals)
    said.push({
      text: `${counted(n.approvals, "One thing needs", "things need")} your yes.`,
      to: "today-needs",
    });
  if (n.ready)
    said.push({
      text: `I wrote ${counted(n.ready, "a draft", "drafts")}, ready to send.`,
      to: "today-drafts",
    });
  if (n.approvals === 0 && n.ready === 0)
    said.push({ text: "Nothing needs you.", to: "today-needs" });
  if (n.owed)
    said.push({
      text: `${counted(n.owed, "One email is", "emails are")} waiting on your reply.`,
      to: "today-replies",
    });
  if (n.due)
    said.push({ text: `${counted(n.due, "One task is", "tasks are")} due.`, to: "today-due" });
  return said;
}

/**
 * The greeting's second half, how the day looks: "It's a light Friday." with a meeting or none and
 * little else, "It's a full Friday." with five meetings or eight things between meetings and what's
 * due, and plainly "Here's your Friday." between.
 */
export function dayLooks(n: { meetings: number; due: number; waiting: number }, now: Date) {
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  if (n.meetings >= 5 || n.meetings + n.due + n.waiting >= 8) return `It's a full ${weekday}.`;
  if (n.meetings <= 1 && n.due + n.waiting <= 3) return `It's a light ${weekday}.`;
  return `Here's your ${weekday}.`;
}

/**
 * What Pip told you that you haven't seen, newest first: not the brief (it has its own place), not
 * a card asking for your yes (that's in Needs you), and not a note of something it did on its own
 * with an Undo (that's in What I did).
 */
export function newFromPip(inbox: readonly InboxRow[] | undefined, shown = 3) {
  const rows = (inbox ?? []).filter(
    (r) =>
      r.notification.state === "unseen" &&
      r.notification.lane === "signal" &&
      r.notification.kind !== "brief" &&
      !r.notification.approvalId &&
      !r.notification.undo,
  );
  return { rows: rows.slice(0, shown), more: Math.max(0, rows.length - shown) };
}

/** A thing Pip did: a record it made, or a change it made to your calendar on its own. */
export type PipDid =
  | {
      kind: "made";
      at: string;
      did: Did;
      /** It can go to the trash from here (and come back from the toast's Undo). */
      undo: boolean;
    }
  /** A change with its own exact Undo (D71, D72): taking back a yes, moving an event back. */
  | { kind: "changed"; at: string; row: InboxRow };

/**
 * What Pip did since `since`, newest first: what it made (jarvis.did) and the changes it made on
 * its own that it can put back. A record it made can be taken back when it's a kind you can move
 * to the trash yourself (`trashable`, lib/trash.ts): a task, a note, a brief. A draft can't: it's
 * in Ready to send, to send or change.
 */
export function pipDid(
  made: readonly Did[] | undefined,
  inbox: readonly InboxRow[] | undefined,
  trashable: ReadonlySet<string>,
  since: Date,
): PipDid[] {
  const from = since.getTime();
  const items: PipDid[] = [
    ...(made ?? []).map(
      (did): PipDid => ({ kind: "made", at: did.at, did, undo: trashable.has(did.entityType) }),
    ),
    ...(inbox ?? [])
      .filter((r) => r.notification.undo && Date.parse(r.notification.createdAt) >= from)
      .map((row): PipDid => ({ kind: "changed", at: row.notification.createdAt, row })),
  ];
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
