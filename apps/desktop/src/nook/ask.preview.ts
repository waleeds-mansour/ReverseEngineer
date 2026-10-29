// The dev-only preview of the quick-ask box (ask.html), at its window's size over a stand-in for
// an app, fed a view from the query: ?s= typing, continuing, fresh, listening, held, hearing,
// heard, busy, waiting, sending, sent, late, failed or nothing; &theme= one of Nook's themes;
// &still=1 for no motion. Keys and clicks ask a stand-in for Rust that answers as Rust would in
// the plain cases, and what was asked is kept in window.__askAsked. vite.config.ts never builds
// this page; the shots of it are taken headless (D:\hearth-build\loop\o6\shots.mjs).

import "./nook.css";
import "./ask.css";
import "./askMic.css";
import type { AskCmd, AskView } from "@/bindings";
import { type AskLink, startAsk } from "./askView";

const q = new URLSearchParams(location.search);
const root = document.documentElement;
root.dataset.theme = q.get("theme") ?? "dark";
if (q.get("still") === "1") root.setAttribute("data-reduced", "");

const style = document.createElement("style");
style.textContent = `
  html.ask-preview { background: radial-gradient(120% 140% at 0% 0%, #3b5bdb 0%, #7048e8 38%, #c2255c 100%); }
  html.ask-preview body { width: 560px; height: 168px; margin: 36px auto 0; }`;
document.head.append(style);

const said = "Remind me to call Sam at five about the venue";
const thread = "Find a time with Sam next week";
const base: AskView = {
  seq: 1,
  phase: "typing",
  from: 'From Google Chrome: "Pull request #194 · Ask Pip from any app"',
  draft: null,
  note: null,
  undo_ms: 0,
  answered: false,
  mic: "ready",
  heard: null,
  continuing: null,
  fresh: false,
  chrome: null,
};

const states: Record<string, Partial<AskView>> = {
  typing: {},
  continuing: { continuing: thread, draft: "Make it Thursday afternoon" },
  fresh: { fresh: true, draft: "Book a dentist for Friday" },
  listening: { mic: "listening" },
  held: { mic: "held", from: null, continuing: thread },
  hearing: { mic: "hearing" },
  heard: { heard: said },
  busy: { mic: "busy" },
  waiting: { phase: "waiting", draft: said, undo_ms: 800, continuing: thread },
  sending: {
    phase: "sending",
    draft: said,
    note: "Too late, it went to Pip.",
  },
  sent: { phase: "sent", note: "Sent to Pip", continuing: said },
  late: { phase: "sent", note: "Too late, it went to Pip.", continuing: said },
  failed: {
    phase: "failed",
    draft: "Book the room for Thursday",
    note: "Couldn't reach Nook. Is it running?",
  },
  nothing: { note: "Didn't catch that. Try again, or type it." },
};

let view: AskView = { ...base, ...states[q.get("s") ?? "typing"] };
const handlers: ((v: AskView) => void)[] = [];
const asked: AskCmd[] = [];
(window as unknown as { __askAsked: AskCmd[] }).__askAsked = asked;

/** The next view, as Rust would make it, with nothing put back or heard twice. */
const next = (change: Partial<AskView>) => {
  view = { ...view, draft: null, heard: null, ...change, seq: view.seq + 1 };
  return view;
};
let pending: number | undefined;
const later = (ms: number, change: Partial<AskView>) => {
  pending = window.setTimeout(
    () => handlers.forEach((h) => h(next(change))),
    ms,
  );
};

const answer = (cmd: AskCmd): AskView => {
  switch (cmd.kind) {
    case "listen":
      return next({ mic: "listening", note: null });
    case "stop_listening":
      if (cmd.keep) later(900, { mic: "ready", heard: said });
      return next({ mic: cmd.keep ? "hearing" : "ready" });
    case "fresh":
      return next({ fresh: !view.fresh });
    case "send":
      later(2000, { phase: "sent", note: "Sent to Pip", continuing: thread });
      return next({ phase: "waiting", undo_ms: 2000 });
    case "undo":
      window.clearTimeout(pending);
      return next({ phase: "typing", draft: said });
    default:
      return view;
  }
};

const link: AskLink = {
  ask: async (cmd) => {
    asked.push(cmd);
    return answer(cmd);
  },
  onView: (h) => {
    handlers.push(h);
  },
};

startAsk({ link });
