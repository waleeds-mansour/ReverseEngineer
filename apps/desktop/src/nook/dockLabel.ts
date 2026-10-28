// Where the agent dock's status label is, told to Nook (src-tauri/src/nook/dockclip.rs). Nook clips
// the dock's window to what its page draws, so the room around the tab and the pill takes no
// clicks, and the label is the one thing there whose size only the page knows: it is as wide as
// its words, and glides from dot to dot over the general spring. So while it glides, Nook is told
// the whole stretch between where it was and where it goes, and once it has settled, just where it
// is; as it fades out, Nook keeps its box until the fade is over and is then told it is gone. Only
// changes are sent, and the same aim twice restarts nothing, since the page draws the label again
// on every move of the pointer.

import type { UiCmd } from "@/bindings";

/** The label's box, in CSS px from the window's top, and how wide it is. */
export interface Span {
  top: number;
  bottom: number;
  wide: number;
}

/** Both boxes, and everything between. */
export const union = (a: Span | null, b: Span): Span =>
  a
    ? {
        top: Math.min(a.top, b.top),
        bottom: Math.max(a.bottom, b.bottom),
        wide: Math.max(a.wide, b.wide),
      }
    : b;

/** The command for `s`, in whole px that cover it; 0 wide for no label. */
export const labelCmd = (s: Span | null): UiCmd =>
  s
    ? {
        kind: "dock_label",
        top: Math.floor(s.top),
        bottom: Math.ceil(s.bottom),
        wide: Math.ceil(s.wide),
      }
    : { kind: "dock_label", top: 0, bottom: 0, wide: 0 };

/** The page's timers, so a test can stand in for them. */
export interface Clock {
  later(run: () => void, ms: number): number;
  cancel(id: number): void;
}

const pageClock: Clock = {
  later: (run, ms) => window.setTimeout(run, ms),
  cancel: (id) => window.clearTimeout(id),
};

/** Tells Nook where the label is going: a box, or null as it fades out. `settleMs` is how long a
 * glide or a fade takes. */
export function labelReporter(
  send: (cmd: UiCmd) => void,
  settleMs: () => number,
  clock: Clock = pageClock,
) {
  /** What Nook was last told, what was last sent, and where the label was last going. */
  let told: Span | null = null;
  let sent = "";
  let aim: string | null = null;
  let settle: number | undefined;
  const tell = (s: Span | null) => {
    told = s;
    const cmd = labelCmd(s);
    const key = JSON.stringify(cmd);
    if (key === sent) return;
    sent = key;
    send(cmd);
  };
  return (to: Span | null) => {
    const key = to && JSON.stringify(labelCmd(to));
    if (key === aim) return;
    aim = key;
    if (settle !== undefined) clock.cancel(settle);
    if (to) tell(union(told, to));
    settle = clock.later(() => {
      settle = undefined;
      tell(to);
    }, settleMs());
  };
}
