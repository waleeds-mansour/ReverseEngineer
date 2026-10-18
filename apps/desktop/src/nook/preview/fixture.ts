// The dev-only preview's stand-in for Nook (never built: vite.config.ts lists only the real
// pages). It answers the bar and popover with a fixture state and chrome taken from the address:
//   ?theme=dusk&mood=thinking&waiting=2&services=down&glass=0&reduced=1&popover=1&quiet=1&app=Figma
// and keeps every command it was asked in window.__nookAsked, for the screenshot script.

import type {
  ChromeView,
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
    ...SERVICES[q.get("services") ?? "ok"],
  },
  pip: {
    mood: (q.get("mood") ?? "idle") as PipMood,
    changed: 1,
    waiting: Number(q.get("waiting") ?? 0),
    stop_key: ["Esc"],
  },
  bar: {
    on: true,
    shown: true,
    why_not: null,
    popover: flag("popover"),
    quiet: flag("quiet"),
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
    return { state, saved: null, chrome };
  },
  onState: () => {},
  onChrome: () => {},
};

/** The clock the screenshots show. */
export const fixedNow = () => new Date(2026, 9, 13, 9, 41);
