// What the Inbox panel says (inboxPanel.ts runs it, inboxParts.ts builds it): the words for each
// kind of card, and the panel filled in for the card in front, or the short message and its one
// button while the desk is shut, opening, can't open here, or has nothing waiting.

import {
  attr,
  fillDots,
  fillNote,
  fillRows,
  type InboxParts,
  text,
} from "./inboxParts";
import {
  dotsOf,
  type Flow,
  noteOf,
  recommendedOf,
  rowsOf,
  takesWords,
} from "./inboxFlow";
import type { InboxCard, InboxView } from "./inboxTypes";

export interface Words {
  /** The card's header. */
  head: string;
  /** Pip's line under its name. */
  sub: string;
  /** What Pip asks or did. */
  ask: string;
  /** What a yes would do, for an approval. */
  line: string;
}

/** The card's words, by kind. */
export function words(card: InboxCard, now: number): Words {
  const ago = since(card.at, now);
  const waiting = "Waiting for your answer";
  switch (card.kind) {
    case "question":
      return { head: "Pip asks you", sub: waiting, ask: card.title, line: "" };
    case "approval": {
      const sub = [waiting, reach(card.risk)].filter(Boolean).join(" · ");
      return { head: "Needs your yes", sub, ask: card.title, line: card.line };
    }
    case "finished":
      return {
        head: card.title,
        sub: `Finished ${ago}`,
        ask: card.line,
        line: "",
      };
    case "brief":
      return {
        head: card.title,
        sub: `Your brief · ${ago}`,
        ask: card.line,
        line: "",
      };
    default:
      return {
        head: card.title,
        sub: `Your evening · ${ago}`,
        ask: card.line,
        line: "",
      };
  }
}

/** How far a yes reaches, in plain words (packages/core's risks). */
function reach(risk: string | null): string {
  if (risk === "self_external") return "reaches your accounts";
  if (risk === "outward") return "reaches other people";
  if (risk === "destructive") return "can't be undone";
  if (risk === "secret") return "touches a password or key";
  return "";
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function since(at: string, now: number): string {
  const mins = Math.floor((now - Date.parse(at)) / 60_000);
  if (!(mins >= 1)) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

/** Whether the desk can't open here and Today in Hearth's window is the way on. */
export const toToday = (v: InboxView | null) =>
  v?.trouble?.word === "no_hello" || v?.trouble?.word === "connect";

/** The message in place of a card, and its one button. */
export function drawGate(p: InboxParts, v: InboxView | null) {
  let title = "Inbox";
  let says = "Looking at what waits…";
  let go = "";
  if (v?.phase === "shut") {
    says = v.trouble?.says ?? "Unlock with Windows Hello to see what waits.";
    go = "Unlock with Windows Hello";
  } else if (v?.phase === "opening") says = "Waiting for Windows Hello…";
  else if (v?.phase === "trouble") {
    says = v.trouble?.says ?? "The desk can't open here.";
    go = toToday(v) ? "Open Today in Hearth" : "Try again";
  } else if (v?.phase === "open") {
    title = "All clear";
    says = "Nothing waits for you.";
  }
  text(p.gateTitle, title);
  text(p.gateSays, says);
  text(p.gateGoText, go);
  attr(p.gateGo, "hidden", go ? null : "");
}

/** No card in front: the header's plain title, and no note, as the message says it all. */
export function drawNoCard(p: InboxParts) {
  fillDots(p.dots, []);
  text(p.title, "Inbox");
  attr(p.note, "hidden", "");
}

/** The card in front, as the flow has it: its words, its rows (the chosen one green while its
 * answer waits or once sent), the reply field or Open and Clear, the dots and the note. */
export function drawCard(
  p: InboxParts,
  card: InboxCard,
  flow: Flow,
  now: number,
  pick: (row: number) => void,
) {
  attr(p.note, "hidden", null);
  const w = words(card, now);
  text(p.title, w.head);
  text(p.whoSub, w.sub);
  const done = card.kind === "finished";
  const asking = card.kind === "approval" || card.kind === "question";
  attr(p.whoDot, "data-tone", done ? "done" : asking ? "asking" : null);
  text(p.askText, w.ask);
  attr(p.ask, "hidden", w.ask ? null : "");
  attr(p.outside, "hidden", card.outside ? null : "");
  text(p.line, w.line);
  attr(p.line, "hidden", w.line ? null : "");
  const rows = rowsOf(card);
  attr(p.label, "hidden", done && rows.length > 0 ? null : "");
  fillRows(
    p.rows,
    rows.map((r) => r.label),
    recommendedOf(card),
    pick,
  );
  attr(p.rows, "hidden", rows.length ? null : "");
  const chosen = flow.pick && flow.pick.id === card.id ? flow.pick.row : null;
  [...p.rows.children].forEach((r, i) =>
    attr(r, "data-chosen", chosen === i ? "" : null),
  );
  attr(
    p.rows,
    "data-picked",
    chosen !== null && flow.phase !== "ask" ? "" : null,
  );
  attr(p.reply, "hidden", takesWords(card) ? null : "");
  attr(p.acts, "hidden", rows.length === 0 || done ? null : "");
  attr(p.clear, "hidden", asking ? "" : null);
  fillDots(p.dots, dotsOf(flow));
  const note = noteOf(flow);
  fillNote(p.note, note.bits, note.tone);
}
