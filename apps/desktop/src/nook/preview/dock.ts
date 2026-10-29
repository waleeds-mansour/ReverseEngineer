// The dev-only preview of Nook's agent dock, fed by fixture.ts. The page stands in for the screen:
// the dock's window is framed at its right edge (or left, with &edge=left), 520 px deep and as tall
// as the page, as Nook makes it once, so what doesn't fit the window is cut off here as it is
// there. &bezel=1 puts the black bezel beyond that edge, which the notch merges with, &frame=1
// outlines the window, and &region=1 outlines what the page last told Nook it draws, which is all
// of the window that shows or takes the pointer besides Nook's own piece for the tab.
//
// &show= sets it up as the owner would: open (the pointer rests on the tab), lip (and on dot &dot,
// 0 by default), menu ("…"), inbox (the Inbox, on a fake desk), chat (the chat with Pip, on a long
// thread: chatFixture.ts), stub (a stand-in panel in the chat's place) or notice (one drops from
// the folded tab). The window is as tall as the page, so a short page is a short work area: 544 px
// is a 1080p screen at 125 % with the dock at 150 %, where a tall panel must keep its field. &film=1 stops the notch's clock, and
// window.__advance(ms) steps it by hand, for the frame strips, which open a panel or drop a notice
// with window.__open(kind) and window.__notice(). window.__ready says it is set up.

import "../nook.css";
import "../dock.css";
import "../dockColumn.css";
import "../panels";
import "./preview.css";
import type { InboxCard } from "@/bindings";
import type { Ticker } from "../dockMotion";
import { el, text } from "../dockParts";
import { startDock } from "../dockView";
import { CARDS, fakeDesk, T } from "../inboxFixtures";
import { inboxPanel } from "../inboxPanel";
import { startRun } from "../inboxRun";
import type { Link } from "../link";
import { showNotice } from "../noticePanel";
import {
  type NotchPanel,
  openPanel,
  type PanelKind,
  registerPanel,
} from "../notchPanel";
import { chatFixture } from "./chatFixture";
import { chrome, fakeLink } from "./fixture";

declare global {
  interface Window {
    __advance: (ms: number) => void;
    __open: (kind: PanelKind) => void;
    __notice: () => void;
    __ready: boolean;
  }
}

const root = document.documentElement;
const q = new URLSearchParams(location.search);
for (const flag of ["bezel", "frame"]) {
  if (q.get(flag) === "1") root.setAttribute(`data-${flag}`, "");
}
root.setAttribute("data-edge", chrome.dock.edge);
const nav = document.getElementById("dock") as HTMLElement;

// What the page tells Nook it draws, outlined over the window.
const NS = "http://www.w3.org/2000/svg";
const overlay = document.createElementNS(NS, "svg");
overlay.classList.add("preview-region");
if (q.get("region") === "1") document.body.append(overlay);
const outline = () => {
  const r = nav.getBoundingClientRect();
  overlay.setAttribute("viewBox", `0 0 ${r.width} ${r.height}`);
  overlay.replaceChildren(
    ...window.__nookShape.map((poly) => {
      const p = document.createElementNS(NS, "polygon");
      p.setAttribute("points", poly.map((pt) => pt.join(",")).join(" "));
      return p;
    }),
  );
};
const link: Link = {
  ...fakeLink,
  ask: async (cmd) => {
    const reply = await fakeLink.ask(cmd);
    if (cmd.kind === "dock_shape") outline();
    return reply;
  },
};

// The Inbox on a fake desk with three cards, its clock stopped.
const { question, approval, finished } = CARDS as Record<string, InboxCard>;
registerPanel("inbox", (at) =>
  inboxPanel(
    startRun(fakeDesk("open", [question, approval, finished]), {
      now: () => T,
      clock: false,
    }),
    at,
  ),
);

/** A stand-in for a panel the notch doesn't have yet: a few lines, 360 by 200. */
function stubPanel(): NotchPanel {
  const e = el("div", "preview-stub");
  const head = el("b", "preview-stub-head");
  text(head, "A panel");
  e.append(head);
  for (const line of [
    "Whatever opens in the notch sits here,",
    "beside the column, on the same black.",
    "Esc closes it.",
  ]) {
    const p = el("p", "preview-stub-line");
    text(p, line);
    e.append(p);
  }
  return {
    kind: "chat",
    wantsKeys: true,
    size: () => ({ wide: 360, tall: 200 }),
    mount: (host) => host.append(e),
    unmount: () => e.remove(),
    onResize: () => {},
  };
}
if (q.get("show") === "stub" || q.get("film") === "1") {
  registerPanel("chat", () => stubPanel());
}
if (q.get("show") === "chat") registerPanel("chat", chatFixture);

// &film=1: the notch's frames come only when the strip asks for them.
let ticker: Ticker | undefined;
if (q.get("film") === "1") {
  const waiting = new Map<number, (now: number) => void>();
  let ids = 0;
  let now = 0;
  ticker = {
    request: (cb) => {
      waiting.set(++ids, cb);
      return ids;
    },
    cancel: (id) => void waiting.delete(id),
  };
  window.__advance = (ms) => {
    for (let t = 0; t < ms - 1e-6; t += 1000 / 60) {
      now += 1000 / 60;
      const due = [...waiting.values()];
      waiting.clear();
      for (const cb of due) cb(now);
    }
  };
}

startDock({ link, ticker });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const point = (x: number, y: number) =>
  document.dispatchEvent(
    new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true }),
  );
/** The pointer rests on the tab, as the owner's would. */
const onTab = () => {
  const r = nav.getBoundingClientRect();
  const x = chrome.dock.edge === "left" ? r.left + 10 : r.right - 10;
  point(x, r.top + chrome.dock.mid);
};

const notice = () =>
  showNotice({ id: "f1", kind: "finished", heading: "Pip finished something" });
window.__open = (kind) => openPanel(kind);
window.__notice = notice;

async function show(what: string | null) {
  await wait(300);
  if (what === "notice") notice();
  else if (what) {
    onTab();
    await wait(150);
    if (what === "lip") {
      const dot =
        document.querySelectorAll(".nd-dot")[Number(q.get("dot") ?? 0)];
      const r = dot?.getBoundingClientRect();
      if (r) point(r.left + r.width / 2, r.top + r.height / 2);
    }
    if (what === "menu") openPanel("menu");
    if (what === "inbox") openPanel("inbox");
    if (what === "stub" || what === "chat") openPanel("chat");
  }
  await wait(q.get("film") === "1" ? 0 : 900);
  window.__ready = true;
}
void show(q.get("show"));
