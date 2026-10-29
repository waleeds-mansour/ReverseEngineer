// The agent dock's dots and the lip that says what one is doing (dockView.ts): what a click on a
// dot asks of Nook, the lip's words for the hovered dot (dockHover.ts's labelText), and the box
// beside the column the notch should grow: the open panel's frame, or the hovered dot's lip.

import type { AgentDot, ChromeView, UiCmd } from "@/bindings";
import { cardAction, labelText } from "./dockHover";
import {
  column,
  items,
  lipBox,
  openMid,
  panelBox,
  panelRoom,
} from "./dockLayout";
import type { Aim } from "./dockNotch";
import { attr, type DockParts, text } from "./dockParts";
import { PANEL_MAX, type PanelSize } from "./notchPanel";

/** What a click on `dot` asks of Nook. */
export function clickFor(chrome: ChromeView, dot: AgentDot | undefined): UiCmd {
  // What waits for the owner is on Hearth; anything else is in the bar's popover, when it's up.
  if (chrome.bar.shown && dot?.state !== "needs_you") {
    return { kind: "popover", open: !chrome.bar.popover };
  }
  return { kind: "open_today" };
}

/** Puts `dot`'s state and last line in the lip, or takes it away for none. */
export function drawLip(ui: DockParts, dot: AgentDot | undefined) {
  attr(ui.box, "data-lip", dot ? "" : null);
  if (!dot) return;
  const { head, tail } = labelText(dot);
  text(ui.lipHead, head);
  text(ui.lipTail, tail);
  attr(ui.lip, "data-state", dot.state);
  const { label, page } = cardAction(dot.kind);
  ui.lip.dataset.page = page;
  attr(ui.lip, "title", label);
  attr(ui.lip, "aria-label", `${tail ? `${head}: ${tail}` : head}. ${label}`);
}

/**
 * The box beside the column: the open panel's frame for `size`, or with none, the lip of the
 * hovered dot, `lip` px across, while the notch is open; or nothing.
 */
export function boxFor(
  c: ChromeView,
  { open, mid, high }: { open: boolean; mid: number; high: number },
  size: PanelSize | null,
  hovered: string | null,
  lip: number,
): Aim["box"] {
  const n = c.agents.length;
  const col = column(open ? 1 : 0, n, mid, high);
  if (size) {
    const w = Math.min(PANEL_MAX.wide, size.wide);
    const h = Math.min(PANEL_MAX.tall, size.tall, panelRoom(high));
    return { kind: "panel", at: panelBox(col, w, h, high) };
  }
  if (!open || !hovered) return null;
  const i = c.agents.findIndex((a) => a.id === hovered);
  const y = items(n, openMid(n, mid, high)).dots[i];
  return y === undefined ? null : { kind: "lip", at: lipBox(col, y, lip) };
}
