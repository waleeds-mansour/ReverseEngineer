// The dev-only preview of the notch's Inbox and notice panels (inboxPanel.ts, noticePanel.ts),
// each state in a black box padded as the notch pads a panel, at 150 % zoom, on one fixed clock
// (inboxFixtures.ts) with the answers' timers stopped, so every shot reads the same. The last box
// moves between cards on window.__swap(), for the card-to-card frame strip. vite.config.ts never
// builds this page; the shots are taken headless (D:\hearth-build\loop\n2\shots.mjs).

import "./nook.css";
import type { InboxCard, InboxPhase, InboxTrouble } from "@/bindings";
import { setSprings } from "./dockSpring";
import { CARDS, fakeDesk, NOTICES, T, TROUBLE } from "./inboxFixtures";
import { inboxPanel } from "./inboxPanel";
import { type InboxRun, startRun } from "./inboxRun";
import type { NotchPanel } from "./notchPanel";
import { noticePanel } from "./noticePanel";

declare global {
  interface Window {
    __swap: () => void;
    __ready: boolean;
  }
}

const root = document.documentElement;
root.dataset.theme = "dark";
setSprings(root);
const q = new URLSearchParams(location.search);
if (q.get("still") === "1") root.setAttribute("data-reduced", "");

const style = document.createElement("style");
style.textContent = `
  html.inbox-preview, html.inbox-preview body { margin: 0; background: #2b2f3a; }
  #wall { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 28px 24px;
    padding: 24px; zoom: 1.5; }
  .pv { display: flex; flex-direction: column; gap: 6px; }
  .pv > span { font: 500 10px/14px var(--font-sans); color: rgb(255 255 255 / 0.55); }
  .pv-notch { padding: 16px; border-radius: 22px; background: #000; overflow: hidden; }`;
document.head.append(style);

const wall = document.getElementById("wall") as HTMLElement;
let clock = T;
const now = () => clock;

/** A labelled black box with `panel` mounted in it, as the notch would. */
function box(name: string, panel: NotchPanel): HTMLElement {
  const fig = document.createElement("figure");
  fig.className = "pv";
  fig.dataset.shot = name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  fig.style.margin = "0";
  const label = document.createElement("span");
  label.textContent = name;
  const notch = document.createElement("div");
  notch.className = "pv-notch";
  fig.append(label, notch);
  wall.append(fig);
  panel.onResize(() => {});
  panel.onClose?.(() => {});
  panel.mount(notch);
  return notch;
}

/** An Inbox on a desk in `phase` with `cards`, its clock stopped, after `then` has acted on it. */
function inbox(
  name: string,
  phase: InboxPhase,
  cards: InboxCard[],
  then: (run: InboxRun) => void = () => {},
  trouble: InboxTrouble | null = null,
): InboxRun {
  const run = startRun(fakeDesk(phase, cards, trouble), { now, clock: false });
  box(name, inboxPanel(run));
  then(run);
  return run;
}

const { question, approval, finished, brief, wrap } = CARDS as Record<
  string,
  InboxCard
>;

inbox("question, Recommended", "open", [question!, approval!, finished!]);
inbox("approval", "open", [approval!, finished!]);
inbox("finished, two ready replies", "open", [finished!, brief!]);
inbox("brief", "open", [brief!, wrap!]);
inbox("undo ring at mid-wait", "open", [question!, approval!], (run) => {
  // Picked a second ago: the ring, drawn from the wait's clock, is half full.
  clock = T - 1000;
  run.press("2");
  clock = T;
});
inbox("sent", "open", [finished!, brief!], (run) => {
  clock = T - 2000;
  run.press("1");
  clock = T;
  run.tick();
});
inbox("all clear", "open", []);
inbox("desk shut", "shut", []);
inbox("opening with Windows Hello", "opening", []);
inbox(
  "can't open here (no Windows Hello)",
  "trouble",
  [],
  () => {},
  TROUBLE.no_hello!,
);
inbox("Hearth not answering", "trouble", [], () => {}, TROUBLE.offline!);

for (const { name, notice, card } of NOTICES)
  box(name, noticePanel(notice, { now, clock: false, sound: () => {}, card }));

const swap = inbox("card to card", "open", [question!, approval!, finished!]);
window.__swap = () => void swap.press("j");

// The fake desk answers on the next turn: draw once its answers are in.
setTimeout(() => (window.__ready = true), 50);
