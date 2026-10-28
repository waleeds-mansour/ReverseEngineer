// Presses on the agent dock (dockView.ts): pressing the edge tab or the open pill and moving a few
// px drags the tab along its edge, which Nook carries out itself, following the pointer, so the
// page only says when a press has become a drag (dockHover.ts's drags). The release that ends a
// drag clicks nothing, whatever ends up under it. A right click anywhere on the tab or the pill
// opens Nook's menu for the dock, never the page's own.

import type { UiCmd } from "@/bindings";
import { drags } from "./dockHover";

export interface Presses {
  /** Whether the press now down has become a drag. */
  dragged(): boolean;
  /** The pointer moved, in the page: a press may have become a drag, or ended unseen. */
  moved(e: PointerEvent): void;
}

export function presses({
  nav,
  pressable,
  pressing,
  changed,
  ask,
}: {
  /** The page's dock, whose clicks a drag's release must not reach. */
  nav: HTMLElement;
  /** What a press can drag from: the tab and the pill. */
  pressable: readonly HTMLElement[];
  /** Any press on them, left or right (the sounds may play only after one). */
  pressing: () => void;
  /** A drag began or ended, so what the pointer wants is read again. */
  changed: () => void;
  ask: (cmd: UiCmd) => void;
}): Presses {
  /** Where a press began, on the screen, until the button comes up, and whether it dragged. */
  let press: { x: number; y: number } | null = null;
  let dragged = false;

  for (const e of pressable) {
    e.addEventListener("pointerdown", (ev) => {
      pressing();
      if (ev.button !== 0) return;
      press = { x: ev.screenX, y: ev.screenY };
      dragged = false;
    });
  }
  /** The press is over: a drag's own release has had its click by the time this runs. */
  const released = () => {
    press = null;
    if (!dragged) return;
    setTimeout(() => {
      dragged = false;
      changed();
    });
  };
  document.addEventListener("pointerup", released);
  nav.addEventListener(
    "click",
    (e) => {
      if (!dragged) return;
      e.stopPropagation();
      e.preventDefault();
      dragged = false;
    },
    true,
  );
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (pressable.some((p) => p.contains(e.target as Node))) {
      ask({ kind: "dock_menu" });
    }
  });

  return {
    dragged: () => dragged,
    moved(e) {
      // The button came up outside the window, where the page didn't see it.
      if (press && (e.buttons & 1) === 0) released();
      if (!press || dragged || (e.buttons & 1) === 0) return;
      if (!drags(press, { x: e.screenX, y: e.screenY })) return;
      dragged = true;
      changed();
      ask({ kind: "dock_drag" });
    },
  };
}
