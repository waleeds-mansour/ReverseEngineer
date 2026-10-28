// Which dot the agent dock's card is about (dockView.ts). The card follows the dot actually under
// the pointer, read again whenever the pointer moves and whenever the dots change under a pointer
// that stays still, so a dot that moves, comes or goes never leaves the card on the wrong one.
// Between dots, over the card or in the room beside the strip, it stays on the dot it was on while
// that dot is still there; once the pointer has left, it is about nothing. The card has one button,
// which opens the page of Hearth where the dot's agent is; and a press on the strip that moves a
// few px before it comes up drags the strip rather than clicking a dot.

import type { AgentKind, DockPage } from "@/bindings";

/**
 * The dot the card is about now: `was` before, `inside` whether the pointer is in the dock's
 * window, `under` the dot under it if any, and `ids` the dots there are.
 */
export function follow(
  was: string | null,
  inside: boolean,
  under: string | null,
  ids: readonly string[],
): string | null {
  if (!inside) return null;
  if (under !== null) return ids.includes(under) ? under : null;
  return was !== null && ids.includes(was) ? was : null;
}

/**
 * Whether Nook closed the card, or wouldn't open it, on its own: a view that says the card has no
 * room while the page last asked for room and is waiting on nothing. Nook closes it once the
 * pointer has left the window, whatever the page heard, and when the dock hides. Until the pointer
 * moves in the page again there is nothing to follow, so the page doesn't ask again at once.
 */
export function nookClosed(
  asked: boolean,
  open: boolean,
  waiting: boolean,
): boolean {
  return asked && !open && !waiting;
}

/** The button on the card for a dot of `kind`: what it says, and the page of Hearth it opens. */
export function cardAction(kind: AgentKind): { label: string; page: DockPage } {
  switch (kind) {
    case "pip":
      return { label: "Open conversation", page: "conversation" };
    case "approvals":
      return { label: "Review", page: "approvals" };
    case "service":
      return { label: "Open status", page: "status" };
  }
}

/** How far the pointer moves with the button down, in CSS px, before a press drags the strip. */
export const DRAG_AFTER = 4;

/** Whether a press at `from` that is now at `to` drags the strip rather than clicks a dot. */
export function drags(
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_AFTER;
}
