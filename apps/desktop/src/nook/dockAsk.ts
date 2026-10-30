// What the agent dock's page tells Nook in order. Each kind of telling goes one ask at a time, so
// Nook carries them out in the order they were made, and only the latest waiting goes. The notch's
// shape (UiCmd::DockShape): whether the notch is open, whether a panel holds it open, and the
// outlines its window's region should take in besides the tab (dockclip.rs); one that says nothing
// new isn't sent, and Nook answers one once the region is set. The keyboard (UiCmd::DockKeys): a
// panel opening and another closing at once could otherwise reach Nook as letting go and then
// taking, which leaves it taken.

import type { ChromeView, UiCmd } from "@/bindings";
import type { Link } from "./link";

/** Asks one at a time, the latest waiting replacing any other; `answered` hears each reply. What
 * send() gives back settles once Nook has answered that ask, or the one that replaced it. */
function inOrder(link: Link, answered: (c: ChromeView) => void) {
  let asking = false;
  let next: UiCmd | null = null;
  let waiting: (() => void)[] = [];

  const pump = () => {
    if (asking || !next) return;
    const cmd = next;
    const done = waiting;
    next = null;
    waiting = [];
    asking = true;
    void link
      .ask(cmd)
      .then((reply) => answered(reply.chrome))
      .catch(() => {})
      .finally(() => {
        asking = false;
        for (const d of done) d();
        pump();
      });
  };

  return {
    send(cmd: UiCmd): Promise<void> {
      next = cmd;
      const heard = new Promise<void>((d) => waiting.push(d));
      pump();
      return heard;
    },
    /** An ask is out or waiting, so a view from Nook may not have heard it yet. */
    busy: () => asking || next !== null,
  };
}

export function shapeTeller(link: Link, answered: (c: ChromeView) => void) {
  const asks = inOrder(link, answered);
  let last = "";
  let open = false;

  return {
    /** Settles once Nook has set the region for it, or null when it says nothing new. */
    tell(cmd: {
      open: boolean;
      hold: boolean;
      outlines: [number, number][][];
    }): Promise<void> | null {
      const ask: UiCmd = { kind: "dock_shape", ...cmd };
      const key = JSON.stringify(ask);
      if (key === last) return null;
      last = key;
      open = cmd.open;
      return asks.send(ask);
    },
    /** Nook was last told the notch is open. */
    toldOpen: () => open,
    busy: asks.busy,
  };
}

/** Takes the keyboard for a panel or lets it go, in the order asked (dockkeys.rs). While an ask is
 * out, a view saying the keyboard went may be from before it, so it isn't a click elsewhere. */
export function keysTeller(link: Link, answered: (c: ChromeView) => void) {
  const asks = inOrder(link, answered);
  return {
    tell: (take: boolean) => asks.send({ kind: "dock_keys", take }),
    busy: asks.busy,
  };
}
