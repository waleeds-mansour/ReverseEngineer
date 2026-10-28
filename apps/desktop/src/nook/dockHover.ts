// What the agent dock does under the pointer (dockView.ts), decided without a page so it can be
// tested. Resting on the edge tab opens the pill; it stays open while the pointer is over or near
// the column, or over the status label beside it, and closes once the pointer has moved away. The
// label is about the dot actually under the pointer, read again whenever the pointer moves and
// whenever the dots change under a pointer that stays still, so a dot that moves, comes or goes
// never leaves it on the wrong one. Between dots, or over the label, it stays on the dot it was on
// while that dot is still there; once the pointer has left, it is about nothing. The label says the
// dot's state and its last line, and is itself one button, which opens the page of Hearth where
// the dot's agent is. The Inbox button opens what waits for the owner (inboxCmd). A press on the tab or
// the pill that moves a few px before it comes up drags the tab rather than clicking anything.

import type {
  AgentDot,
  AgentKind,
  AgentState,
  DockPage,
  UiCmd,
} from "@/bindings";

/**
 * The dot the label is about now: `was` before, `inside` whether the pointer is in the open pill's
 * reach, `under` the dot under it if any, and `ids` the dots there are.
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
 * Whether Nook closed the pill, or wouldn't open it, on its own: a view that says it has no room
 * while the page last asked for room and is waiting on nothing. Nook closes it once the pointer
 * has left the window, whatever the page heard, and when the dock hides. Until the pointer moves
 * in the page again there is nothing to follow, so the page doesn't ask again at once.
 */
export function nookClosed(
  asked: boolean,
  open: boolean,
  waiting: boolean,
): boolean {
  return asked && !open && !waiting;
}

/** What the label does for a dot of `kind`, as its tooltip says it, and the page of Hearth it opens. */
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

/**
 * What the Inbox button asks of Nook: for now Hearth's window on Today, where what waits for a yes
 * is listed, as a needs-you dot's click does. The Inbox of its own takes this over.
 */
export function inboxCmd(): UiCmd {
  return { kind: "open_today" };
}

const STATE: Record<AgentState, string | null> = {
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
  idle: null,
};

/**
 * The label beside a hovered dot: its state, then its last line ("Working", "Thinking about your
 * brief"). A service says which it is instead, since its amber already says it needs the owner,
 * and a dot at rest says only its line.
 */
export function labelText(dot: AgentDot): { head: string; tail: string } {
  const state = STATE[dot.state];
  if (dot.kind === "service") return { head: dot.label, tail: dot.line };
  if (!state) return { head: dot.line, tail: "" };
  const same = dot.line.trim().toLowerCase() === state.toLowerCase();
  return { head: state, tail: same ? "" : dot.line };
}

/** A box in the page, in CSS px. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far around the column the pointer may wander before the pill closes. */
export const REACH = 20;

const within = (p: { x: number; y: number }, b: Box, by = 0) =>
  p.x >= b.left - by &&
  p.x < b.right + by &&
  p.y >= b.top - by &&
  p.y < b.bottom + by;

/** Whether the pointer at `p` keeps the open pill open: near the column, or over the label. */
export function stays(
  p: { x: number; y: number },
  column: Box,
  label: Box | null,
): boolean {
  return within(p, column, REACH) || (label !== null && within(p, label));
}

/** How far the pointer moves with the button down, in CSS px, before a press drags the tab. */
export const DRAG_AFTER = 4;

/** Whether a press at `from` that is now at `to` drags the tab rather than clicks. */
export function drags(
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_AFTER;
}
