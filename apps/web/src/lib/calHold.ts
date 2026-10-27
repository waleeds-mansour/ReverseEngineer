// Holding an event on Calendar's grid to move it. A press stays a click, which opens the popover as
// before, till the pointer moves a few px: only then is the event picked up and the pointer
// captured, so a plain click never goes to the wrong place. While it's held the grid draws it where
// it would land; letting go drops it there, and Esc puts it back. The click that ends a drag opens
// nothing. A lost release (the button let go outside the window, the window losing focus, the
// capture taken away) puts it back too: nothing is saved that wasn't dropped. A finger scrolls the
// grid as before: dragging is for a mouse or a pen.

import { type Accessor, createSignal, onCleanup } from "solid-js";
import { pastSlop, type Span } from "./calDrag.ts";
import type { CalEvent } from "./types.ts";

/** A press on an event: what's pressed, and the grid's own measures from that moment. */
export interface Grab {
  e: CalEvent;
  mode: "move" | "resize";
  /** The day of the column or cell it was picked up from. */
  day: Date;
  /** Where the pointer went down. */
  x: number;
  y: number;
}

/** Where a held event would land: its times, and how far its block moves on screen, in px. */
export interface Landing extends Span {
  dx: number;
  dy: number;
  /** In a month, the day cell it's over (-1 for none). */
  over?: number;
  /** Where it would sit, when its own element doesn't go there as it's dragged (a month's chip). */
  box?: DOMRect;
}

export type Held<G extends Grab> = Landing & { grab: G; x: number; y: number };

/** What an event's tile needs to be dragged. */
export interface TileDrag {
  /** It can be moved: it shows the grab cursor. */
  can: boolean;
  press: (ev: PointerEvent) => void;
}

const holdingNow = createSignal(false);
/** Whether an event is held anywhere: Calendar's keys (t, ←, →, d, w, m) wait till it's let go. */
export const holding = holdingNow[0];
const setHolding = holdingNow[1];

/** The click a drag ends with would open the event: it's swallowed, just this once. */
function swallowClick() {
  const stop = (c: Event) => {
    c.stopPropagation();
    c.preventDefault();
  };
  const w = window;
  w.addEventListener("click", stop, { capture: true, once: true });
  w.setTimeout(() => w.removeEventListener("click", stop, { capture: true }), 0);
}

export function createDrag<G extends Grab>(opts: {
  /** Where a grabbed event lands with the pointer at (x, y), the grid scrolled as it is now. */
  land: (g: G, x: number, y: number) => Landing;
  /** Let go: the event, where it landed, and where that is on screen (for a question beside it). */
  drop: (e: CalEvent, to: Span, at: DOMRect) => void;
}): {
  held: Accessor<Held<G> | undefined>;
  press: (ev: PointerEvent, g: Omit<G, "x" | "y">) => void;
  /** Puts back what's held, if anything (the days shown changed under it). */
  cancel: () => void;
} {
  const [shown, setShown] = createSignal<Held<G>>();
  /** The press under way: put it back (wait for the release), or forget it at once. */
  let current: { putBack: () => void; end: () => void } | undefined;
  onCleanup(() => current?.end());

  const press = (ev: PointerEvent, g: Omit<G, "x" | "y">) => {
    if (ev.button !== 0 || ev.pointerType === "touch") return;
    // One still open never saw its release: it's over, and this one starts afresh.
    current?.end();
    const el = ev.currentTarget as HTMLElement;
    const grab = { ...g, x: ev.clientX, y: ev.clientY } as G;
    const id = ev.pointerId;
    let dragging = false;
    let back = false;
    let at = { x: ev.clientX, y: ev.clientY };
    // Where it was last drawn: the grid can draw it again as a new element while it's held.
    let box = el.getBoundingClientRect();
    const show = () => {
      setShown({ grab, ...at, ...opts.land(grab, at.x, at.y) });
      if (el.isConnected) box = el.getBoundingClientRect();
    };

    const move = (m: PointerEvent) => {
      if (m.pointerId !== id) return;
      // The button came up where Nook didn't hear it: put back, never saved.
      if (m.buttons === 0) return end();
      if (back) return;
      at = { x: m.clientX, y: m.clientY };
      if (!dragging) {
        if (!pastSlop(at.x - grab.x, at.y - grab.y)) return;
        dragging = true;
        setHolding(true);
        try {
          el.setPointerCapture(id);
        } catch {
          // Already let go: the up that follows ends it.
        }
      }
      m.preventDefault();
      show();
    };
    // The grid scrolled under a still pointer (a wheel while dragging): it lands elsewhere.
    const scrolled = () => {
      if (dragging && !back) show();
    };
    const up = (u: PointerEvent) => {
      if (u.pointerId !== id) return;
      const h = shown();
      // Read while it's still drawn where it was dropped.
      const where = h?.box ?? (el.isConnected ? el.getBoundingClientRect() : box);
      end();
      if (!dragging) return;
      swallowClick();
      if (h && !back) opts.drop(grab.e, { start: h.start, end: h.end }, where);
    };
    const cancelled = (c: PointerEvent) => {
      if (c.pointerId === id) end();
    };
    // Its capture taken away while it's still there (a menu, the system). One drawn again as a new
    // element loses it too, and goes on being dragged.
    const lost = (c: Event) => {
      if ((c as PointerEvent).pointerId === id && el.isConnected) end();
    };
    const key = (k: KeyboardEvent) => {
      if (k.key !== "Escape" || !dragging || back) return;
      k.preventDefault();
      k.stopPropagation();
      putBack();
    };
    /** Back where it was; letting go after doesn't drop it, or open it. */
    const putBack = () => {
      if (!dragging) return end();
      back = true;
      setShown();
      setHolding(false);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("blur", end);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scrolled, true);
      el.removeEventListener("lostpointercapture", lost);
      try {
        if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
      } catch {
        // Gone with its element.
      }
      setShown();
      if (dragging) setHolding(false);
      current = undefined;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelled);
    window.addEventListener("blur", end);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scrolled, true);
    el.addEventListener("lostpointercapture", lost);
    current = { putBack, end };
  };

  return { held: shown, press, cancel: () => current?.putBack() };
}
