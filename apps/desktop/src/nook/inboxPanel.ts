// The Inbox, as a panel in the agent dock's notch (notchPanel.ts): Pip's questions, what waits for
// your yes, finished work with its ready replies, the brief and the evening wrap, one card at a
// time, answered from the keyboard. inboxRun.ts keeps what it shows and its clock for the page's
// life, inboxDraw.ts says the words and inboxParts.ts builds the content; this draws a run into
// the notch while the panel is open. The notch gives the dock's window the keyboard while it is,
// and hands it back to the app you were in when it closes.
//
// Moving between cards, the old content slides 24 px out to the side it leaves by over 160 ms
// while the new one springs in from the other side (380/32), on a still frame. The panel is 380
// px wide and as tall as its content, and the notch morphs whenever that changes.

import "./inbox.css";
import "./inboxBody.css";
import "./inboxNote.css";
import { type NotchPanel, PANEL_MAX, registerPanel } from "./notchPanel";
import { tauriLink } from "./link";
import { current, filled } from "./inboxFlow";
import { drawCard, drawGate, drawNoCard } from "./inboxDraw";
import { attr, buildInbox, RING_LONG } from "./inboxParts";
import { type InboxRun, inboxLink, startRun } from "./inboxRun";

/** The panel's width, in CSS px at 1x. */
export const INBOX_WIDE = 380;
/** How long the old content takes to leave. */
const LEAVE_MS = 160;

export function inboxPanel(run: InboxRun, at?: string): NotchPanel {
  const p = buildInbox();
  let resized = () => {};
  let closing = () => {};
  /** What the stage shows: a card's id, or "" for the message. */
  let shown: string | null = null;
  let tall = 0;
  let frame = 0;
  let unwatch = () => {};
  const ro = new ResizeObserver(() => {
    const h = Math.ceil(p.root.offsetHeight);
    if (h === tall) return;
    tall = h;
    resized();
  });

  const reduced = () =>
    document.documentElement.hasAttribute("data-reduced") ||
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** The old content leaves toward `dir`'s far side while the new one comes in from the near. */
  const slide = (dir: 1 | -1) => {
    p.root.querySelector(".ni-leaving")?.remove();
    attr(p.stage, "data-in", null);
    if (reduced()) return;
    const old = p.stage.cloneNode(true) as HTMLElement;
    old.className = "ni-stage ni-leaving";
    old.setAttribute("aria-hidden", "true");
    old.setAttribute("data-dir", dir > 0 ? "next" : "prev");
    old.inert = true;
    p.stage.before(old);
    setTimeout(() => old.remove(), LEAVE_MS + 40);
    void p.stage.offsetWidth;
    attr(p.stage, "data-in", dir > 0 ? "next" : "prev");
  };

  /** The undo ring follows the wait's own clock, so it is right however late it is drawn. */
  const fill = () => {
    cancelAnimationFrame(frame);
    const flow = run.flow();
    const left = RING_LONG * (1 - filled(flow, run.now()));
    p.ring.setAttribute("stroke-dashoffset", left.toFixed(2));
    if (flow.phase === "wait") frame = requestAnimationFrame(fill);
  };

  const render = () => {
    const v = run.view();
    const flow = run.flow();
    const card = v?.phase === "open" ? current(flow) : null;
    const id = card?.id ?? "";
    if (shown !== null && id !== shown) slide(card ? flow.dir : 1);
    shown = id;
    // The field holds the run's words for this card: kept through a take-back or a close, and
    // cleared once they went. They can't change while they wait.
    const words = card ? run.words(card.id) : "";
    if (p.input.value !== words) p.input.value = words;
    p.input.readOnly = flow.phase !== "ask";
    attr(p.root, "data-phase", v?.phase ?? "loading");
    attr(p.root, "data-card", card ? card.kind : null);
    attr(p.root, "data-stage", flow.phase);
    drawGate(p, v);
    if (card)
      drawCard(p, card, flow, run.now(), (n) => run.press(String(n + 1)));
    else drawNoCard(p);
    fill();
  };

  const typed = () => void run.typed(p.input.value);
  p.input.addEventListener("input", () => {
    if (shown) run.setWords(shown, p.input.value);
  });
  p.close.addEventListener("click", () => closing());
  p.undo.addEventListener("click", () => run.press("Escape"));
  p.open.addEventListener("click", () => run.press("o"));
  p.clear.addEventListener("click", () => run.press("e"));
  p.send.addEventListener("click", typed);
  p.gateGo.addEventListener("click", () => run.gate());
  p.root.tabIndex = -1;

  return {
    kind: "inbox",
    wantsKeys: true,
    size: () => ({
      wide: INBOX_WIDE,
      tall: Math.min(PANEL_MAX.tall, tall || 160),
    }),
    mount(el) {
      el.append(p.root);
      unwatch = run.watch((shut) => (shut ? closing() : render()));
      run.open(at);
      render();
      tall = Math.ceil(p.root.offsetHeight);
      ro.observe(p.root);
      p.root.focus({ preventScroll: true });
    },
    unmount() {
      ro.disconnect();
      unwatch();
      cancelAnimationFrame(frame);
      p.root.remove();
      // Takes back an answer still waiting, which no one could see or stop now.
      run.close();
    },
    key(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      const inField = e.target === p.input;
      if (inField && e.key === "Enter") {
        e.preventDefault();
        typed();
        return true;
      }
      if (inField && e.key !== "Escape") return false;
      // A held key answers once, and a held Esc takes an answer back without closing the Inbox.
      if (e.repeat) return true;
      const used = run.press(e.key);
      if (used) e.preventDefault();
      return used;
    },
    onResize(cb) {
      resized = cb;
    },
    onClose(cb) {
      closing = cb;
    },
  };
}

let shared: InboxRun | null = null;

/** The page's one Inbox run, made the first time the notch opens the Inbox or a notice asks. */
export function inboxRun(): InboxRun {
  return (shared ??= startRun(inboxLink(tauriLink)));
}

/** A card from the Inbox's own view, while it has the desk open: what a notice says under its
 * heading. Nothing when the Inbox hasn't been opened yet. */
export const inboxCard = (id: string) =>
  shared?.view()?.phase === "open" ? shared.card(id) : undefined;

registerPanel("inbox", (at) => inboxPanel(inboxRun(), at));
