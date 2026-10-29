// The quick-ask box's parts (askView.ts draws them): the line of context with its ×, the 48 px
// pill with the mic, the text, "Sent to Pip" and the Undo ring with its Esc key, and the line
// below it, which says where the ask goes, what went wrong, Pip's first words back and which keys
// do what. The icons are drawn here, our own, in the text's colour.

import type { AskView } from "@/bindings";

export const askCopy = {
  label: "Ask Pip",
  placeholder: "Ask Pip anything…",
  listening: "Listening…",
  hearing: "Writing down what you said…",
  hint: "Enter to send · Esc to close",
  hintListening: "Space to stop · Esc to cancel",
  hintHeld: "Let go of Ctrl to stop",
  hintWaiting: "Esc to take it back",
  open: "Enter opens the conversation",
  drop: "Send without this",
  undo: "Take it back (Esc)",
  sent: "Sent to Pip",
  mic: "Talk to Pip",
  micStop: "Stop listening",
  micBusy: "The microphone is busy with another recording",
  continuing: "Continuing:",
  forNew: "for a new one",
  fresh: "New conversation",
  toContinue: "to continue",
};

/** Which keys do what now, at the end of the line below the pill. */
export function hintFor(
  v: Pick<AskView, "mic" | "phase" | "continuing">,
): string {
  if (v.mic === "listening") return askCopy.hintListening;
  if (v.mic === "held") return askCopy.hintHeld;
  if (v.mic === "hearing" || v.phase === "sending") return "";
  if (v.phase === "waiting") return askCopy.hintWaiting;
  // Sent, the pill says so, and the line says where a follow-up goes when it can.
  if (v.phase === "sent") return v.continuing === null ? askCopy.open : "";
  return askCopy.hint;
}

const SVG = "http://www.w3.org/2000/svg";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text = "",
) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function svg(cls: string, size: number, view: number, shapes: string[][]) {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("class", cls);
  s.setAttribute("width", String(size));
  s.setAttribute("height", String(size));
  s.setAttribute("viewBox", `0 0 ${view} ${view}`);
  s.setAttribute("aria-hidden", "true");
  for (const [tag, ...attrs] of shapes) {
    const shape = document.createElementNS(SVG, tag);
    for (let i = 0; i + 1 < attrs.length; i += 2)
      shape.setAttribute(attrs[i], attrs[i + 1]);
    s.append(shape);
  }
  return s;
}

/** A microphone: a capsule on a stand; busy, struck through. */
const micIcon = () =>
  svg("na-mic-icon", 16, 16, [
    ["rect", "x", "5.5", "y", "1.5", "width", "5", "height", "8", "rx", "2.5"],
    ["path", "d", "M3.25 7.5a4.75 4.75 0 0 0 9.5 0M8 12.25v2.25"],
    ["path", "class", "na-mic-strike", "d", "M2.5 2.5l11 11"],
  ]);

const checkIcon = () =>
  svg("na-check", 14, 16, [["path", "d", "M3.5 8.5l3 3 6-7"]]);

/** The Undo countdown: a track, and a ring filling clockwise from twelve o'clock. */
const ringIcon = () =>
  svg("na-ring", 16, 20, [
    ["circle", "class", "na-ring-track", "cx", "10", "cy", "10", "r", "7.5"],
    ["circle", "class", "na-ring-fill", "cx", "10", "cy", "10", "r", "7.5"],
  ]);

export type AskParts = ReturnType<typeof buildAsk>;

export function buildAsk(card: HTMLElement) {
  const fromRow = el("div", "na-from-row");
  const from = el("p", "re-caption na-from");
  const drop = el("button", "na-drop", "×");
  drop.type = "button";
  drop.title = askCopy.drop;
  drop.setAttribute("aria-label", askCopy.drop);
  fromRow.append(from, drop);

  const pill = el("div", "na-pill");
  const mic = el("button", "na-mic");
  mic.type = "button";
  const wave = el("span", "na-wave");
  for (let i = 0; i < 5; i++) wave.append(el("i", ""));
  mic.append(micIcon(), wave);
  const field = el("div", "na-field");
  const input = el("input", "na-input");
  input.type = "text";
  input.maxLength = 4000;
  input.autocomplete = "off";
  input.spellcheck = true;
  input.setAttribute("aria-label", askCopy.label);
  const sent = el("span", "na-sent");
  const sentText = el("span", "na-sent-text", askCopy.sent);
  sent.append(sentText, checkIcon());
  field.append(input, sent);
  const undo = el("button", "na-undo");
  undo.type = "button";
  undo.title = askCopy.undo;
  undo.setAttribute("aria-label", askCopy.undo);
  undo.append(ringIcon(), el("kbd", "na-key na-esc", "Esc"));
  pill.append(mic, field, undo);

  const foot = el("div", "na-foot");
  foot.setAttribute("role", "status");
  foot.setAttribute("aria-live", "polite");
  const thread = el("span", "na-thread");
  const threadText = el("span", "na-thread-text");
  const threadKey = el("kbd", "na-key na-tab", "Tab");
  const threadTail = el("span", "na-thread-tail");
  thread.append(threadText, threadKey, threadTail);
  const said = el("span", "na-said");
  const answer = el("button", "na-answer");
  answer.type = "button";
  const hint = el("span", "na-hint");
  foot.append(thread, said, answer, hint);

  card.append(fromRow, pill, foot);
  const ringFill = undo.querySelector(".na-ring-fill") as SVGCircleElement;
  return {
    fromRow,
    from,
    drop,
    pill,
    mic,
    input,
    sent,
    sentText,
    undo,
    ringFill,
    foot,
    thread,
    threadText,
    threadKey,
    threadTail,
    said,
    answer,
    hint,
  };
}
