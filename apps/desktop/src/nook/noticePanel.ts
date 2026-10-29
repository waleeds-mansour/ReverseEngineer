// A notice of something new, as a panel in the agent dock's notch (notchPanel.ts): a small pill out
// of the tab, as wide as its words, for a card that just came to the desk, in place of a Windows
// notification while the dock shows (src-tauri's hearth/notify.rs decides, and sends
// "nook://dock-notice" to the dock's window with the card's id, kind and the feed's heading). It
// says that heading ("Pip asks you something"), as Hearth's feed never carries a question's words,
// and under it what the card says only when the Inbox's own view has the card, with the desk open.
//
// It plays the dock's tone for its kind (dockSound.ts), closes itself after six seconds unless
// the pointer rests on it, and a click opens the Inbox at its card. It never takes the keyboard,
// and never takes the place of a panel you're in (the Inbox, the chat with Pip, the dock's menu):
// then the card just waits in the Inbox, as it does while the dock is hidden for a game.

import "./inboxBody.css";
import "./notice.css";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { isTauri } from "@tauri-apps/api/core";
import type { Cue } from "./dockSound";
import { el } from "./dockParts";
import { since } from "./inboxDraw";
import { attr, glyph, pipMark, text } from "./inboxParts";
import type { InboxCard } from "./inboxTypes";
import { inboxCard } from "./inboxPanel";
import {
  type NotchPanel,
  openKind,
  openPanel,
  registerPanel,
} from "./notchPanel";

export const NOTICE_EVENT = "nook://dock-notice";
/** How long a notice stays while the pointer isn't on it. */
export const NOTICE_MS = 6000;
/** The least it stays once the pointer has left it. */
const AFTER_HOVER_MS = 1500;
/** The widest a notice gets, in CSS px at 1x (notice.css's max-width): it is as wide as its
 * words. */
export const NOTICE_MOST = 260;
/** The black round a notice, less than a panel's, so it reads as a small pill out of the tab. */
export const NOTICE_PAD = 10;
const CHEVRON = "M6 3.5L10.5 8 6 12.5";

/** What notify.rs sends: the card's id, its kind and the feed's heading. */
export interface DockNotice {
  id: string;
  kind: string;
  heading: string;
}

/** The dock's tone for a kind of card: finished work is "done", anything else waits for you. */
export const cueOf = (kind: string): Cue =>
  kind === "finished" ? "done" : kind === "health" ? "trouble" : "asks";

/** The line under the heading: the card's title, or for the brief and the wrap what they say. */
export function lineOf(c: InboxCard | null): string {
  if (!c) return "";
  return c.kind === "brief" || c.kind === "wrap" ? c.line || c.title : c.title;
}

export interface NoticeOptions {
  now?: () => number;
  /** False for the preview's still shots: the notice then stays. */
  clock?: boolean;
  /** Plays the notice's tone; the dock's player, unless the preview says otherwise. */
  sound?: (cue: Cue) => void;
  /** The card, when the Inbox's own view has it with the desk open. */
  card?: InboxCard | null;
}

/** Tones already played, so a notice opened again for the same card is quiet. */
const played = new Set<string>();

export function noticePanel(
  n: DockNotice,
  opts: NoticeOptions = {},
): NotchPanel {
  const now = opts.now ?? (() => Date.now());
  const card = opts.card ?? null;
  const root = el("button", "nn");
  root.type = "button";
  root.setAttribute("aria-label", `${n.heading}. Open it in the Inbox`);
  attr(root, "data-kind", n.kind);
  const [mark, dot] = pipMark();
  const asks = n.kind === "approval" || n.kind === "question";
  attr(
    dot,
    "data-tone",
    n.kind === "finished" ? "done" : asks ? "asking" : null,
  );
  const words = el("span", "nn-words");
  const top = el("span", "nn-top");
  const head = el("b", "nn-head");
  text(head, n.heading);
  const when = el("span", "nn-when");
  text(when, since(card?.at ?? new Date(now()).toISOString(), now()));
  top.append(head, when);
  const line = el("span", "nn-line");
  const said = lineOf(card);
  line.append(document.createTextNode(said));
  // Words someone else wrote (an email's, a page's) are marked as theirs, never as Pip's.
  if (card?.outside) {
    const outside = el("span", "ni-outside");
    outside.textContent = "from outside";
    line.append(outside);
  }
  attr(line, "hidden", said ? null : "");
  words.append(top, line);
  const go = el("span", "nn-go");
  go.append(glyph(CHEVRON, 12));
  root.append(mark, words, go);

  let closing = () => {};
  let resized = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let left = NOTICE_MS;
  let armedAt: number | null = null;
  let wide = 0;
  let tall = 0;
  /** Takes its size as drawn; true when it changed. */
  const measure = () => {
    const w = Math.ceil(root.offsetWidth);
    const h = Math.ceil(root.offsetHeight);
    if (w === wide && h === tall) return false;
    [wide, tall] = [w, h];
    return true;
  };
  const ro = new ResizeObserver(() => {
    if (measure()) resized();
  });

  /** The clock runs while the pointer is off the notice, and holds while it rests there. */
  const arm = () => {
    if (opts.clock === false || armedAt !== null) return;
    armedAt = now();
    timer = setTimeout(() => closing(), left);
  };
  const hold = () => {
    if (armedAt === null) return;
    clearTimeout(timer);
    left = Math.max(AFTER_HOVER_MS, left - (now() - armedAt));
    armedAt = null;
  };
  root.addEventListener("pointerenter", hold);
  root.addEventListener("pointerleave", arm);
  root.addEventListener("click", () => openPanel("inbox", n.id));

  return {
    kind: "notice",
    wantsKeys: false,
    size: () => ({
      wide: wide || NOTICE_MOST,
      tall: tall || 18,
      pad: NOTICE_PAD,
    }),
    mount(host) {
      host.append(root);
      measure();
      ro.observe(root);
      if (!root.matches(":hover")) arm();
      if (!played.has(n.id)) {
        played.add(n.id);
        (opts.sound ?? sound)(cueOf(n.kind));
      }
    },
    unmount() {
      ro.disconnect();
      clearTimeout(timer);
      root.remove();
    },
    onResize(cb) {
      resized = cb;
    },
    onClose(cb) {
      closing = cb;
    },
  };
}

const notices = new Map<string, DockNotice>();
// TODO(N1): play through the dock's own player, which knows the Sounds switch and plays at most
// one tone a second, once dockSound.ts or dockView.ts exports it, so a notice and its badge going
// up sound once. Until then the dock hands it over with noticeSounds(), and notices are quiet.
let sound: (cue: Cue) => void = () => {};

/** The dock hands notices its player. */
export function noticeSounds(play: (cue: Cue) => void): void {
  sound = play;
}

/** A notice from Nook: the notch opens it, unless a panel you're in is open (every one but a
 * notice takes the keyboard); the card waits in the Inbox then. */
export function showNotice(n: DockNotice): void {
  const open = openKind();
  if (!n.id || (open !== null && open !== "notice")) return;
  notices.set(n.id, n);
  if (notices.size > 20) notices.delete(notices.keys().next().value!);
  openPanel("notice", n.id);
}

registerPanel("notice", (id = "") =>
  noticePanel(notices.get(id) ?? { id, kind: "", heading: "Something new" }, {
    card: inboxCard(id),
  }),
);

// In Hearth's app only: the dev-only preview has no Nook to hear from.
if (isTauri())
  void getCurrentWebviewWindow().listen<DockNotice>(NOTICE_EVENT, (e) =>
    showNotice(e.payload),
  );
