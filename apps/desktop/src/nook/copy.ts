// Everything Nook's panel says, in one place. Nook's surfaces are English for now; the words
// follow Hearth's voice: plain, calm, no exclamation marks.

import type { VerdictName, WindowState } from "@/bindings";

export const copy = {
  title: "Arrange windows",
  preview: "Preview",
  intro:
    "Nook is watching your windows and deciding what it would do with each one. It doesn't move, hide or change any of them.",
  observing: "Observing",
  off: "Off",
  observeLabel: "Keep observing when this panel is closed",
  observeHint:
    "Nook watches in the background and writes nothing. Turn it off any time.",
  barLabel: "Show the Nook bar along the top of your main screen",
  barHint:
    "The app in front, Nook's services, Pip and the time. It observes while it's on, hides over games and fullscreen video, and changes no window.",
  dockLabel: "Show the agent dock on the left edge of your main screen",
  dockHint:
    "A dot for Pip, and one for any of Nook's services that needs you. It stays on top, hides over games and fullscreen video, and changes no window.",
  elevated:
    "Hearth is running as administrator, so Nook will only ever observe. Elevated arrangers can move windows that other apps can't, which Nook won't do.",
  writesTitle: "Changes to your windows",
  writes: (refused: number, landed: number) => {
    if (landed > 0) {
      return `${landed} made. That shouldn't happen while observing; nook.log has the details.`;
    }
    if (refused === 0) return "None. Nook hasn't tried to change a window.";
    const times = refused === 1 ? "once" : `${refused} times`;
    return `None. Nook tried ${times} and was refused, as it should be while observing.`;
  },
  gatesTitle: "Holding off",
  monitorsTitle: "Monitors",
  primary: "Primary",
  arranged: "Nook would arrange this one",
  leftAlone: "Nook leaves this one alone",
  size: (width: number, height: number, dpi: number) =>
    `${width} × ${height} at ${Math.round((dpi / 96) * 100)}%`,
  sep: " · ",
  windowsTitle: "Why not tiled",
  windowsHint:
    "Every window open now, what Nook would do with it, and why. Titles are never shown or kept.",
  nothingMatches: "No window matches.",
  search: "Filter by app or class",
  all: "All",
  verdict: {
    tile: "Tile",
    float: "Float",
    ignore: "Ignore",
  } satisfies Record<VerdictName, string>,
  state: {
    normal: "",
    minimized: "Minimized",
    maximized: "Maximized",
  } satisfies Record<WindowState, string>,
  sticky: "On every workspace",
  columns: {
    app: "App",
    verdict: "Verdict",
    why: "Why",
    monitor: "Monitor",
  },
  refresh: "Look again",
  saveFixtures: "Save fixtures",
  exportDiag: "Export diagnostics",
  savedTo: (path: string) => `Saved to ${path}`,
  problemsTitle: "Your rules",
  failed: (why: string) => `That didn't work: ${why}`,
  loading: "Looking at your windows",
} as const;
