// What the agent dock does under the pointer (dockView.ts), decided without a page so it can be
// tested. Hovering a dot in the open notch shows its status label as a lip of the notch beside it.
// The label is about the dot actually under the pointer, read again whenever the pointer moves and
// whenever the dots change under a pointer that stays still, so a dot that moves, comes or goes
// never leaves it on the wrong one. Between dots, or over the label, it stays on the dot it was on
// while that dot is still there; once the pointer has left, or a panel opens, it is about nothing.
// The label says the dot's state and its last line, and is itself one button, which opens the page
// of Hearth where the dot's agent is. A press on the notch that moves a few px before it comes up
// drags the tab rather than clicking anything.

import type { AgentDot, AgentKind, AgentState, DockPage } from "@/bindings";

/**
 * The dot the label is about now: `was` before, `inside` whether the notch is open with no panel,
 * `under` the dot under the pointer if any, and `ids` the dots there are.
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

/** How far the pointer moves with the button down, in CSS px, before a press drags the tab. */
export const DRAG_AFTER = 4;

/** Whether a press at `from` that is now at `to` drags the tab rather than clicks. */
export function drags(
  from: { x: number; y: number },
  to: { x: number; y: number },
): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_AFTER;
}
