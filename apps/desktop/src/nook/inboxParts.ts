// The Inbox panel's content, built once per panel (inboxPanel.ts fills it): what the notch holds
// on its black, with no frame of its own. Its header has the card's title, a dot per card, and ×;
// while an answer waits there instead is a ring that fills over the two seconds and the esc key
// that takes it back, and then "✓ Sent". Its body is Pip's row (its mark and a status dot, its
// name and what it's doing), what Pip asks or did, the rows 1, 2 and 3 pick (each with its keycap,
// and a Recommended chip on the choice Pip recommends), a "Reply to Pip…" field for a question,
// and Open and Clear for the rest. When the desk is shut, can't open here or has nothing waiting,
// the body gives way to a short message and one button. A note line at the bottom says which keys
// answer, then "✓ Sent to Pip". Pages under Nook's CSP build every element here: nothing is parsed
// from markup.

import { pipSvg } from "./pip";
import { attr, el, text } from "./dockParts";
import { svg } from "./dockShape";
import type { Bit, Dot } from "./inboxFlow";

export interface InboxParts {
  root: HTMLElement;
  title: HTMLElement;
  dots: HTMLElement;
  close: HTMLButtonElement;
  undo: HTMLButtonElement;
  ring: SVGCircleElement;
  /** Holds the body and the message, and the old content while it slides away. */
  stage: HTMLElement;
  body: HTMLElement;
  whoDot: HTMLElement;
  whoSub: HTMLElement;
  ask: HTMLElement;
  askText: HTMLElement;
  line: HTMLElement;
  outside: HTMLElement;
  label: HTMLElement;
  rows: HTMLElement;
  reply: HTMLElement;
  input: HTMLInputElement;
  send: HTMLButtonElement;
  acts: HTMLElement;
  open: HTMLButtonElement;
  clear: HTMLButtonElement;
  gate: HTMLElement;
  gateTitle: HTMLElement;
  gateSays: HTMLElement;
  gateGo: HTMLButtonElement;
  gateGoText: HTMLElement;
  note: HTMLElement;
}

/** A keycap: 16 px, or the esc key's 24. */
export function keycap(label: string, cls = "ni-key"): HTMLElement {
  const k = el("kbd", cls);
  k.textContent = label;
  return k;
}

function button(cls: string, label: string): HTMLButtonElement {
  const b = el("button", cls);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  return b;
}

/** A small line icon on a 16 px grid. */
export function glyph(d: string, size: number): SVGSVGElement {
  const s = svg("svg", {
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    "aria-hidden": "true",
  });
  const p = svg("path", {
    d,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.6,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  s.append(p);
  return s;
}

export const CHECK = "M3.5 8.5l3 3 6-7";
const CROSS = "M4 4l8 8M12 4l-8 8";
const SEND = "M2.5 8h9M8 4.5L11.5 8 8 11.5";

/** 2π × 7.5: the undo ring's whole length. */
export const RING_LONG = 47.124;

/** The undo ring: a track and the arc that fills from 12 o'clock over the wait. */
function ring(): [SVGSVGElement, SVGCircleElement] {
  const s = svg("svg", {
    viewBox: "0 0 20 20",
    width: 16,
    height: 16,
    "aria-hidden": "true",
  });
  const at = { cx: 10, cy: 10, r: 7.5, fill: "none", "stroke-width": 2.2 };
  const track = svg("circle", { ...at, class: "ni-ring-track" });
  const arc = svg("circle", {
    ...at,
    class: "ni-ring-arc",
    transform: "rotate(-90 10 10)",
    "stroke-dasharray": RING_LONG,
    "stroke-dashoffset": RING_LONG,
  });
  s.append(track, arc);
  return [s, arc];
}

/** Pip's mark, 18 px, with the status dot at its corner. */
export function pipMark(): [HTMLElement, HTMLElement] {
  const mark = el("span", "ni-mark");
  mark.append(pipSvg("idle", 18));
  const dot = el("i", "ni-who-dot");
  mark.append(dot);
  return [mark, dot];
}

export function buildInbox(): InboxParts {
  const root = el("section", "ni");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Inbox");

  const head = el("header", "ni-head");
  const title = el("h2", "ni-title");
  const side = el("div", "ni-side");
  const dots = el("span", "ni-dots");
  dots.setAttribute("aria-hidden", "true");
  const close = button("ni-close", "Close (Escape)");
  close.append(glyph(CROSS, 13));
  const undo = button("ni-undo", "Take the answer back (Escape)");
  const [ringSvg, arc] = ring();
  undo.append(ringSvg, keycap("esc", "ni-esc"));
  const sent = el("span", "ni-sent");
  sent.append(glyph(CHECK, 13), document.createTextNode("Sent"));
  // The dots and ×, the ring and esc, and "✓ Sent" share one spot and cross-fade.
  const plain = el("span", "ni-plain");
  plain.append(dots, close);
  side.append(plain, undo, sent);
  head.append(title, side);

  const body = el("div", "ni-body");
  const who = el("div", "ni-who");
  const [mark, whoDot] = pipMark();
  const names = el("span", "ni-names");
  const name = el("b", "ni-name");
  name.textContent = "Pip";
  const whoSub = el("span", "ni-sub");
  names.append(name, whoSub);
  who.append(mark, names);
  const ask = el("p", "ni-ask");
  const askText = el("span", "");
  const line = el("p", "ni-line");
  // Words someone else wrote (an email's, a page's) are marked as theirs, never as Pip's.
  const outside = el("span", "ni-outside");
  outside.textContent = "from outside";
  ask.append(askText, outside);
  const label = el("p", "ni-label");
  label.textContent = "Next steps";
  const rows = el("div", "ni-rows");
  rows.setAttribute("role", "group");
  const reply = el("label", "ni-reply");
  const input = el("input", "ni-input");
  input.type = "text";
  input.placeholder = "Reply to Pip…";
  input.setAttribute("aria-label", "Reply to Pip");
  input.maxLength = 2000;
  const send = button("ni-send", "Send your answer");
  send.append(glyph(SEND, 13));
  reply.append(input, send);
  const acts = el("div", "ni-acts");
  const open = button("ni-act", "");
  open.append(document.createTextNode("Open"), keycap("O"));
  const clear = button("ni-act", "");
  clear.append(document.createTextNode("Clear"), keycap("E"));
  acts.append(open, clear);
  body.append(who, ask, line, label, rows, reply, acts);

  const gate = el("div", "ni-gate");
  const gateTitle = el("b", "ni-gate-title");
  const gateSays = el("span", "ni-gate-says");
  const gateGo = button("ni-gate-go", "");
  const gateGoText = el("span", "");
  gateGo.append(gateGoText, keycap("Enter", "ni-key ni-key-wide"));
  gate.append(gateTitle, gateSays, gateGo);

  const stage = el("div", "ni-stage");
  stage.append(body, gate);
  const note = el("div", "ni-note");
  note.setAttribute("role", "status");
  note.setAttribute("aria-live", "polite");
  root.append(head, stage, note);
  return {
    root,
    title,
    dots,
    close,
    undo,
    ring: arc,
    stage,
    body,
    whoDot,
    whoSub,
    ask,
    askText,
    line,
    outside,
    label,
    rows,
    reply,
    input,
    send,
    acts,
    open,
    clear,
    gate,
    gateTitle,
    gateSays,
    gateGo,
    gateGoText,
    note,
  };
}

/** The rows 1, 2 and 3 pick, with the Recommended chip on `recommended`: drawn again only when
 * the card's labels or its chip change. */
export function fillRows(
  rows: HTMLElement,
  labels: string[],
  recommended: number | null,
  onPick: (n: number) => void,
) {
  const key = JSON.stringify([labels, recommended]);
  if (rows.getAttribute("data-key") === key) return;
  rows.setAttribute("data-key", key);
  const made = labels.map((label, i) => {
    const b = button("ni-row", "");
    b.setAttribute("data-row", String(i));
    const cap = keycap(String(i + 1));
    const check = glyph(CHECK, 9);
    check.classList.add("ni-check");
    cap.append(check);
    const words = el("span", "ni-row-text");
    words.textContent = label;
    b.append(cap, words);
    if (i === recommended) {
      const chip = el("span", "ni-rec");
      chip.textContent = "Recommended";
      b.append(chip);
    }
    b.addEventListener("click", () => onPick(i));
    return b;
  });
  rows.replaceChildren(...made);
}

/** The header's dots, as inboxFlow's dotsOf gives them. */
export function fillDots(dots: HTMLElement, all: Dot[]) {
  while (dots.children.length < all.length) dots.append(el("i", "ni-dot"));
  while (dots.children.length > all.length) dots.lastElementChild?.remove();
  all.forEach((d, i) => attr(dots.children[i]!, "data-dot", d));
}

/** The note's words, with keys drawn as keycaps, and a check once something was sent. */
export function fillNote(note: HTMLElement, bits: Bit[], tone: string) {
  const said = bits
    .map((b) => (typeof b === "string" ? b : `[${b.key}]`))
    .join("");
  if (
    note.getAttribute("data-said") === said &&
    note.getAttribute("data-tone") === tone
  )
    return;
  note.setAttribute("data-said", said);
  note.setAttribute("data-tone", tone);
  const parts: Node[] = tone === "sent" ? [glyph(CHECK, 13)] : [];
  for (const b of bits)
    parts.push(
      typeof b === "string" ? document.createTextNode(b) : keycap(b.key),
    );
  note.replaceChildren(...parts);
  // Comes in again from just below, as the words change.
  note.removeAttribute("data-in");
  void note.offsetWidth;
  note.setAttribute("data-in", "");
}

export { attr, text };
