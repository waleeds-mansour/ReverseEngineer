// Where the agent dock's notch and everything in it go (dockNotch.ts), decided without a page so
// it can be tested. `p` is how open the notch is, 0 for the edge tab and 1 for the open column, on
// a spring that can swing a little past either: the column's numbers, the dots and the badge all
// follow it, so the tab grows into the column as one shape. Only its depth swings past: closing,
// the tab sinks a few px into the edge and springs back out, while its length, and where the dots
// are along it, stop at the tab's. The open column is centred on the
// tab's middle unless that would take it within NOTCH.room px of the work area's top or bottom.
// A panel sits beside the column toward the middle of the screen, top-aligned with the column's
// straight part and kept NOTCH.room px inside the work area; a dot's label is a lip at its dot.

import type { Notch, NotchBox } from "./dockOutline";
import {
  LIP,
  NOTCH,
  PANEL,
  TAB,
  notchBody,
  tabBody,
  tabLong,
} from "./dockShape";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) =>
  hi < lo ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));
/** How open, kept between the tab and the column, for what mustn't swing past either. */
const within = (p: number) => clamp(p, 0, 1);

/** Where the open column's middle goes for a tab whose middle is `mid`, in a work area `high`. */
export function openMid(dots: number, mid: number, high: number): number {
  const half = NOTCH.flare + notchBody(dots) / 2 + NOTCH.room;
  return clamp(mid, half, high - half);
}

/** The column `p` open, with no box. */
export function column(
  p: number,
  dots: number,
  mid: number,
  high: number,
): Notch {
  const t = within(p);
  return {
    mid: lerp(mid, openMid(dots, mid, high), t),
    deep: lerp(TAB.deep, NOTCH.deep, p),
    flare: lerp(TAB.flare, NOTCH.flare, t),
    body: lerp(tabBody(dots), notchBody(dots), t),
    box: null,
  };
}

/** Down the window, the middles of the open column's items. */
export interface Items {
  inbox: number;
  dots: number[];
  pip: number;
  talk: number;
  more: number;
}

export function items(dots: number, mid: number): Items {
  const n = Math.max(1, dots);
  const top = mid - notchBody(dots) / 2 + NOTCH.pad;
  const first = top + NOTCH.button + NOTCH.sep;
  const pip = first + n * NOTCH.dot + NOTCH.sep + NOTCH.button / 2;
  return {
    inbox: top + NOTCH.button / 2,
    dots: Array.from({ length: dots }, (_, i) => first + (i + 0.5) * NOTCH.dot),
    pip,
    talk: pip + NOTCH.button,
    more: pip + 2 * NOTCH.button,
  };
}

/** Where dot `i` is, in from the edge and down: in the tab at rest, in the column open. */
export function dotAt(
  i: number,
  dots: number,
  mid: number,
  high: number,
  p: number,
): [number, number] {
  // At rest, a pixel toward the screen's edge of the tab's middle, as the dots always sat.
  const rest: [number, number] = [
    TAB.deep / 2 - 1,
    mid -
      tabBody(dots) / 2 +
      TAB.pad / 2 +
      TAB.slot / 2 +
      i * (TAB.slot + TAB.gap),
  ];
  const open: [number, number] = [
    NOTCH.deep / 2,
    items(dots, openMid(dots, mid, high)).dots[i] ?? mid,
  ];
  return [lerp(rest[0], open[0], p), lerp(rest[1], open[1], within(p))];
}

/** The count badge: its side toward the middle of the screen, in from the edge, and its top. At
 * rest it is 15 px down the tab and 8 px past it (dockclip.rs's BADGE); open, at the Inbox. */
export function badgeAt(
  dots: number,
  mid: number,
  high: number,
  p: number,
): [number, number] {
  const rest: [number, number] = [TAB.deep + 8, mid - tabLong(dots) / 2 + 15];
  const inbox = items(dots, openMid(dots, mid, high)).inbox;
  const open: [number, number] = [NOTCH.deep / 2 + 15, inbox - 15];
  return [lerp(rest[0], open[0], p), lerp(rest[1], open[1], within(p))];
}

/** The column's straight part, where a box may meet it, for the column as it will be. */
const straight = (c: Notch) => ({
  top: c.mid - c.body / 2,
  bottom: c.mid + c.body / 2,
});

/**
 * A panel's frame beside `col` (the column it will sit by): `wide` by `tall` of content and
 * PANEL.pad round it, top-aligned with the column's straight part and moved up only as far as it
 * takes to stay NOTCH.room px inside the work area, flares and all.
 */
export function panelBox(
  col: Notch,
  wide: number,
  tall: number,
  high: number,
): NotchBox {
  const w = wide + 2 * PANEL.pad;
  const h = tall + 2 * PANEL.pad;
  const edge = col.flare + PANEL.fillet + NOTCH.room;
  const most = high - edge;
  let top = straight(col).top + PANEL.fillet;
  top = Math.max(edge, Math.min(top, most - h));
  return {
    wide: w,
    top,
    bottom: Math.min(top + h, Math.max(top, most)),
    r: PANEL.r,
    fillet: PANEL.fillet,
  };
}

/** The tallest content a panel's frame holds beside the open column in a work area `high`, so a
 * panel never asks for more than shows (dockPanels.ts keeps its element to it). */
export function panelRoom(high: number): number {
  const edge = NOTCH.flare + PANEL.fillet + NOTCH.room;
  return Math.max(0, high - 2 * edge - 2 * PANEL.pad);
}

/** A dot's label: a lip `wide` px across (its words and LIP.pad each side), at the dot `y` down,
 * kept on the column's straight part. */
export function lipBox(col: Notch, y: number, wide: number): NotchBox {
  const half = LIP.tall / 2;
  const s = straight(col);
  const mid = clamp(y, s.top + LIP.fillet + half, s.bottom - LIP.fillet - half);
  return {
    wide: Math.min(LIP.most, wide),
    top: mid - half,
    bottom: mid + half,
    r: LIP.r,
    fillet: LIP.fillet,
  };
}

/** The least and most a spring takes a number to before it settles (dockMotion.ts's reach). */
export interface Span {
  lo: number;
  hi: number;
}

/**
 * The notches a morph may draw at its farthest, for dockOutline.ts's envelope: the column as far
 * closed and as far open as `open` swings, where it is and where it goes, each with the box as far
 * out as its springs take it.
 */
export function morphShapes(
  dots: number,
  mid: number,
  high: number,
  open: Span & { now: number; to: number },
  box: { wide: Span; top: Span; bottom: Span; r: number; fillet: number },
): Notch[] {
  const far: NotchBox | null =
    box.wide.hi > 0.01
      ? {
          wide: box.wide.hi,
          top: box.top.lo,
          bottom: Math.max(box.bottom.hi, box.top.lo),
          r: Math.max(0, box.r),
          fillet: Math.max(0, box.fillet),
        }
      : null;
  return [open.lo, open.hi, open.now, open.to].map((p) => ({
    ...column(p, dots, mid, high),
    box: far,
  }));
}
