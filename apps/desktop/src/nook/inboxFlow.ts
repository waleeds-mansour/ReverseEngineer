// The Inbox's keyboard and its clock, with no page (inboxPanel.ts draws it): which card shows, what
// 1, 2, 3, J, K, E, O, Enter and Esc do to it, and the wait every answer has before it goes.
//
// An answer never goes at once. Picking a choice, a yes or a no, a ready reply, words of your own
// or clearing a card starts WAIT_MS (2 s) in which Esc takes it back and nothing has left; then
// it goes to Nook, "Sent" shows for SENT_MS, and the next card slides in. What waits for a yes, a
// no or an answer can't be cleared with E: the note says to answer it instead. O opens the card
// where it lives, in Hearth's window. Keys do nothing while "Sent" shows, but Esc still closes.
// An answer still waiting when the Inbox closes, or when the desk stops being open, is taken back
// as Esc would: nothing goes that the owner can no longer see or stop. When a new list puts a
// different card in front, 1, 2, 3 and E rest for SETTLE_MS, so a key meant for the card that was
// there can't answer the one that came. Everything here is plain data in, plain data out, so
// inboxFlow.test.ts runs it without a page.

import type { InboxAct, InboxCard } from "./inboxTypes";

/** How long an answer waits for Esc before it goes. */
export const WAIT_MS = 2000;
/** How long "Sent" shows before the next card. */
export const SENT_MS = 1300;
/** How long 1, 2, 3 and E rest after a new list put a different card in front. */
export const SETTLE_MS = 500;
/** The most page dots the card's header shows. */
export const MAX_DOTS = 7;

export interface Row {
  label: string;
  act: InboxAct;
}

/** What 1, 2 and 3 do on a card: its rows, numbered from 1. */
export function rowsOf(card: InboxCard): Row[] {
  if (card.kind === "question") {
    const question_id = card.question_id;
    if (!question_id) return [];
    return card.choices.slice(0, 3).map((label, choice) => ({
      label,
      act: { kind: "answer", question_id, choice, text: null },
    }));
  }
  if (card.kind === "approval") {
    const approval_id = card.approval_id;
    if (!approval_id) return [];
    // Never Always allow from the desk: a yes is for this one call.
    return [
      { label: "Yes", act: { kind: "decide", approval_id, yes: true } },
      { label: "No", act: { kind: "decide", approval_id, yes: false } },
    ];
  }
  return card.replies.slice(0, 2).map((label, choice) => ({
    label,
    act: { kind: "reply", id: card.id, choice },
  }));
}

/** The choice Pip recommends on a question, by place, for its row's Recommended chip: only a
 * choice the card has. */
export function recommendedOf(card: InboxCard): number | null {
  const r = card.recommended;
  const fits = r !== null && Number.isInteger(r) && r >= 0;
  return card.kind === "question" && fits && r < card.choices.length ? r : null;
}

/** Whether E clears it: what waits for a yes, a no or an answer is put away by answering. */
export const clears = (card: InboxCard) =>
  !(
    card.kind === "approval" ||
    (card.kind === "question" && card.question_id !== null)
  );

/** Whether its "Reply to Pip…" field takes words: an open question's does. */
export const takesWords = (card: InboxCard) =>
  card.kind === "question" && card.question_id !== null;

export type Phase = "ask" | "wait" | "sent";

export interface Pick {
  /** The card it answers. */
  id: string;
  /** The row picked, from 0; null for your own words or clearing. */
  row: number | null;
  act: InboxAct;
}

export interface Flow {
  cards: InboxCard[];
  /** The card shown, by place. */
  at: number;
  phase: Phase;
  /** When the phase began, in ms. */
  since: number;
  /** What waits to go, or went. */
  pick: Pick | null;
  /** Which way the last move between cards went. */
  dir: 1 | -1;
  /** Something the note says instead of the card's hint: "answer" for E on what can't be cleared,
   * or Hearth's own words when it said no. */
  said: string | null;
  /** The cards already shown, for the header's dots. */
  shown: string[];
  /** When a new list last put a different card in front, in ms. */
  swapped: number | null;
}

export interface Step {
  flow: Flow;
  /** What the page asks Nook now. */
  out: InboxAct[];
  /** The Inbox closes. */
  close?: boolean;
}

export function begin(cards: InboxCard[], now: number): Flow {
  const flow: Flow = {
    cards,
    at: 0,
    phase: "ask",
    since: now,
    pick: null,
    dir: 1,
    said: null,
    shown: [],
    swapped: null,
  };
  return seen(flow);
}

export const current = (f: Flow): InboxCard | null => f.cards[f.at] ?? null;

/** Marks the shown card as shown. */
function seen(f: Flow): Flow {
  const card = current(f);
  if (!card || f.shown.includes(card.id)) return f;
  return { ...f, shown: [...f.shown, card.id] };
}

const step = (flow: Flow, out: InboxAct[] = []): Step => ({ flow, out });

function move(f: Flow, by: 1 | -1, now: number): Step {
  const at = f.at + by;
  if (at < 0 || at >= f.cards.length) return step(f);
  const card = f.cards[at]!;
  const out: InboxAct[] = card.seen ? [] : [{ kind: "seen", id: card.id }];
  return step(seen({ ...f, at, dir: by, since: now, said: null }), out);
}

function wait(f: Flow, pick: Pick, now: number): Step {
  return step({ ...f, phase: "wait", since: now, pick, said: null });
}

/** A key pressed while the Inbox has the keyboard (its field aside: see typed). */
export function press(f: Flow, key: string, now: number): Step {
  if (key === "Escape") {
    if (f.phase === "wait") return step(takeBack(f, now));
    return { flow: f, out: [{ kind: "close" }], close: true };
  }
  const card = current(f);
  if (f.phase !== "ask" || !card) return step(f);
  const k = key.toLowerCase();
  if (k === "j" || k === "arrowdown") return move(f, 1, now);
  if (k === "k" || k === "arrowup") return move(f, -1, now);
  if (k === "o")
    return { flow: f, out: [{ kind: "show", url: card.url }], close: true };
  // A key meant for the card that was in front a moment ago answers nothing.
  const settling = f.swapped !== null && now - f.swapped < SETTLE_MS;
  if (settling && ["1", "2", "3", "e"].includes(k)) return step(f);
  if (k === "e") {
    if (!clears(card)) return step({ ...f, said: "answer" });
    return wait(
      f,
      { id: card.id, row: null, act: { kind: "clear", id: card.id } },
      now,
    );
  }
  const n = ["1", "2", "3"].indexOf(k);
  const row = n >= 0 ? rowsOf(card)[n] : undefined;
  if (!row) return step(f);
  return wait(f, { id: card.id, row: n, act: row.act }, now);
}

/** Enter in the "Reply to Pip…" field: words of your own, for an open question. */
export function typed(f: Flow, words: string, now: number): Step {
  const card = current(f);
  const text = words.trim();
  if (
    f.phase !== "ask" ||
    !card ||
    !takesWords(card) ||
    !text ||
    !card.question_id
  )
    return step(f);
  const act: InboxAct = {
    kind: "answer",
    question_id: card.question_id,
    choice: null,
    text,
  };
  return wait(f, { id: card.id, row: null, act }, now);
}

/** The clock: an answer goes once its wait is over, and the next card comes after "Sent". */
export function tick(f: Flow, now: number): Step {
  if (f.phase === "wait" && f.pick && now - f.since >= WAIT_MS)
    return step({ ...f, phase: "sent", since: now }, [f.pick.act]);
  if (f.phase === "sent" && now - f.since >= SENT_MS) {
    const gone = f.pick?.id;
    const cards = f.cards.filter((c) => c.id !== gone);
    const at = Math.min(f.at, Math.max(0, cards.length - 1));
    return step(
      seen({ ...f, cards, at, phase: "ask", since: now, pick: null, dir: 1 }),
    );
  }
  return step(f);
}

/**
 * The Inbox opened at a card (a notice's): it comes to the front, unless an answer waits or is
 * going, whose card stays in front, or the list doesn't have it (yet).
 */
export function openAt(f: Flow, id: string): Flow {
  const at = f.cards.findIndex((c) => c.id === id);
  if (at < 0 || at === f.at || f.phase !== "ask") return f;
  return seen({ ...f, at, dir: at > f.at ? 1 : -1, said: null });
}

/** The answer waiting is taken back, as Esc does, and as the Inbox closing or the desk leaving
 * "open" does: the card stays on the desk with nothing picked. */
export function takeBack(f: Flow, now: number): Flow {
  if (f.phase !== "wait") return f;
  return { ...f, phase: "ask", since: now, pick: null };
}

/** Hearth said no to what went: the card comes back with its words. */
export function refused(f: Flow, words: string, now: number): Flow {
  return { ...f, phase: "ask", since: now, pick: null, said: words };
}

/**
 * A new list from Nook, at `now`. The card shown stays shown; while an answer waits or "Sent"
 * shows, its card stays where it was even if the list no longer has it. When the card shown is
 * gone and another takes its place, the keys that answer rest a moment (SETTLE_MS).
 */
export function refresh(f: Flow, cards: InboxCard[], now: number): Flow {
  const shownId = current(f)?.id;
  let next = cards;
  const held = f.pick ? f.cards.find((c) => c.id === f.pick?.id) : undefined;
  if (held && !next.some((c) => c.id === held.id))
    next = [...next.slice(0, f.at), held, ...next.slice(f.at)];
  const kept = next.findIndex((c) => c.id === shownId);
  const at = kept >= 0 ? kept : Math.min(f.at, Math.max(0, next.length - 1));
  const swapped = next[at]?.id !== shownId && next[at] ? now : f.swapped;
  return seen({ ...f, cards: next, at, swapped });
}

/** A piece of the note pill: words, or a key drawn as a keycap. */
export type Bit = string | { key: string };

export interface Note {
  bits: Bit[];
  tone: "hint" | "sent" | "clear" | "warn";
}

/** "1", "1 or 2", "1, 2 or 3", as keycaps. */
function keys(n: number): Bit[] {
  const all: Bit[] = [];
  for (let i = 1; i <= n; i++) {
    if (i > 1) all.push(i === n ? " or " : ", ");
    all.push({ key: String(i) });
  }
  return all;
}

/** What the note pill under the card says. */
export function noteOf(f: Flow): Note {
  const card = current(f);
  if (!card) return { bits: ["All clear"], tone: "clear" };
  if (f.phase === "sent")
    return {
      bits: [f.pick?.act.kind === "clear" ? "Cleared" : "Sent to Pip"],
      tone: "sent",
    };
  if (f.phase === "wait")
    return {
      bits: ["Press ", { key: "esc" }, " to take it back"],
      tone: "hint",
    };
  if (f.said === "answer")
    return { bits: ["Answer this one first"], tone: "warn" };
  if (f.said) return { bits: [f.said], tone: "warn" };
  const rows = rowsOf(card).length;
  if (rows > 0) {
    const verb = card.kind === "finished" ? " to reply" : " to answer";
    return { bits: ["Press ", ...keys(rows), verb], tone: "hint" };
  }
  return {
    bits: ["Press ", { key: "E" }, " to clear, ", { key: "O" }, " to open"],
    tone: "hint",
  };
}

export type Dot = "current" | "seen" | "upcoming";

/** The header's page dots: one per card, at most MAX_DOTS, around the one shown. */
export function dotsOf(f: Flow): Dot[] {
  const start = Math.max(
    0,
    Math.min(f.at - Math.floor(MAX_DOTS / 2), f.cards.length - MAX_DOTS),
  );
  return f.cards.slice(start, start + MAX_DOTS).map((c, i) => {
    if (start + i === f.at) return "current";
    return f.shown.includes(c.id) ? "seen" : "upcoming";
  });
}

/** How many cards wait behind the one shown, drawn as a stack: at most two. */
export const behind = (f: Flow) => Math.min(2, Math.max(0, f.cards.length - 1));

/** How far the undo ring has filled, 0 to 1. */
export const filled = (f: Flow, now: number) =>
  f.phase === "wait" ? Math.min(1, Math.max(0, (now - f.since) / WAIT_MS)) : 0;
