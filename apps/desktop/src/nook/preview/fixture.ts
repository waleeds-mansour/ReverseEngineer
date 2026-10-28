// The dev-only preview's stand-in for Nook (never built: vite.config.ts lists only the real
// pages). It answers the bar, popover and dock with a fixture state and chrome taken from the
// address:
//   ?theme=dusk&mood=thinking&waiting=2&services=down&glass=0&reduced=1&popover=1&quiet=1&app=Figma&edge=left
// and, for the dock, what Hearth's feed says: &turn=working (or thinking) and &yes=2. The dock
// sits on the right edge, as it starts, unless &edge says otherwise. It keeps
// every command it was asked in window.__nookAsked, for the screenshot script, and makes room for
// the dock's card when asked, as Nook does.

import type {
  AgentDot,
  AgentState,
  ChromeView,
  Edge,
  NookState,
  PipMood,
  ServicesView,
  ThemeId,
  UiCmd,
} from "@/bindings";
import type { Link } from "../link";

const q = new URLSearchParams(location.search);
const flag = (name: string) => q.get(name) === "1";

const SERVICES: Record<string, Partial<ServicesView>> = {
  ok: {},
  down: { server: "down", worker: "unknown", pip: "unknown" },
  warn: { worker: "trouble" },
  checking: {
    checked: false,
    server: "unknown",
    worker: "unknown",
    pip: "unknown",
  },
  paused: { pip_paused: true },
};

export const state: NookState = {
  seq: 1,
  mode: "observing",
  why_off: null,
  observe: false,
  panel_open: false,
  elevated: false,
  monitors: [
    {
      id: "fixture-display1",
      name: "DISPLAY1",
      rect: { x: 0, y: 0, width: 2560, height: 1440 },
      work: { x: 0, y: 0, width: 2560, height: 1392 },
      dpi: 96,
      primary: true,
      managed: true,
      note: "",
    },
  ],
  focused: {
    app: q.get("app") ?? "Visual Studio Code",
    exe: "Code.exe",
    verdict: "tile",
    why: "A normal app window",
    game: false,
  },
  gates: [],
  writes: { attempted: 0, refused: 0, landed: 0 },
  windows: [],
  problems: [],
};

const mood = (q.get("mood") ?? "idle") as PipMood;
const waiting = Number(q.get("waiting") ?? 0);
const services = q.get("services") ?? "ok";
const turn = q.get("turn");
const yes = Number(q.get("yes") ?? 0);

/** The dock's dots, roughly as agents.rs picks them. */
function fixtureAgents(): AgentDot[] {
  const pip = (state: AgentState, line: string): AgentDot => ({
    id: "pip",
    label: "Pip",
    kind: "pip",
    state,
    line,
  });
  const service = (id: string, label: string, line: string): AgentDot => ({
    id,
    label,
    kind: "service",
    state: "needs_you",
    line,
  });
  const all = [
    mood === "listening" || mood === "thinking"
      ? pip("working", "Thinking")
      : waiting > 0 && !turn
        ? pip("needs_you", `${waiting} things wait for you`)
        : mood === "happy"
          ? pip("done", "Answered")
          : turn === "working"
            ? pip("working", "Working on your morning brief")
            : turn === "thinking"
              ? pip("working", "Thinking about what you asked")
              : pip("idle", "Resting"),
  ];
  if (yes > 0) {
    all.push({
      id: "approvals",
      label: "Needs your yes",
      kind: "approvals",
      state: "needs_you",
      line: `${yes} things wait for your yes`,
    });
  }
  if (services === "down") {
    all.push(service("server", "Nook's server", "Not answering"));
  }
  if (services === "warn") {
    all.push(service("worker", "Background work", "Having trouble"));
  }
  return all;
}

export const chrome: ChromeView = {
  seq: 1,
  theme: (q.get("theme") ?? "light") as ThemeId,
  glass: q.get("glass") !== "0",
  reduced_motion: flag("reduced"),
  services: {
    checked: true,
    address_set: true,
    server: "ok",
    worker: "ok",
    pip: "ok",
    pip_paused: false,
    other_failing: false,
    ...SERVICES[services],
  },
  pip: {
    mood,
    changed: 1,
    waiting,
    stop_key: ["Esc"],
  },
  bar: {
    on: true,
    shown: true,
    why_not: null,
    popover: flag("popover"),
    quiet: flag("quiet"),
  },
  agents: fixtureAgents(),
  dock: {
    on: true,
    shown: true,
    why_not: null,
    open: false,
    edge: (q.get("edge") ?? "right") as Edge,
  },
};

declare global {
  interface Window {
    __nookAsked: UiCmd[];
  }
}
window.__nookAsked = [];

export const fakeLink: Link = {
  ask: async (cmd) => {
    window.__nookAsked.push(cmd);
    if (cmd.kind === "dock_hover" && chrome.dock.open !== cmd.open) {
      chrome.dock.open = cmd.open;
      chrome.seq += 1;
    }
    return {
      state,
      saved: null,
      chrome: { ...chrome, dock: { ...chrome.dock } },
    };
  },
  onState: () => {},
  onChrome: () => {},
};

/** The clock the screenshots show. */
export const fixedNow = () => new Date(2026, 9, 13, 9, 41);
