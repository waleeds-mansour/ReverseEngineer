// The agent dock's sizes, in CSS px at 1x (the page's zoom, the dock's size setting, scales them
// with everything else), and its icons. The edge tab's are docksize.rs's TAB_* consts, so the tab
// the page draws is the one Nook keeps in the window's region before the page says anything: 25 px
// out from the side of the screen, a straight body that grows with its dots, and a 22 px S-shaped
// flare at each end. Hovered, the same black shape grows into the open notch, 52 px deep with 36 px
// flares (NOTCH), around a column of icons: the Inbox, the agents' dots, Pip's mark, the mic and
// "…", each glyph about 20 px in a 40 px circle. A panel or a dot's label grows out of its middle
// side (PANEL, LIP). The icons are drawn with createElementNS, since Nook's pages allow no inline
// markup or styles.

/** The edge tab at rest: docksize.rs's TAB_* consts. */
export const TAB = {
  deep: 25,
  flare: 22,
  slot: 13,
  gap: 9,
  pad: 25,
} as const;

/** The open notch: docksize.rs's NOTCH_DEEP and EDGE_ROOM, and the column's pitches. */
export const NOTCH = {
  deep: 52,
  flare: 36,
  /** Black before the first icon and after the last, in the straight part. */
  pad: 4,
  /** The pitch of the Inbox, Pip's mark, the mic and "…". */
  button: 44,
  /** Their hit circles, and the glyphs in them. */
  hit: 40,
  glyph: 20,
  /** The pitch of the agents' dots. */
  dot: 28,
  /** Between the Inbox, the dots and the tools. */
  sep: 6,
  /** The least room kept between the notch and the work area's top and bottom. */
  room: 12,
} as const;

/** A panel's frame: its outer corners, the concave fillets where it meets the column, padding. */
export const PANEL = { r: 22, fillet: 10, pad: 16 } as const;

/** A hovered dot's status label, a lip of the notch. */
export const LIP = { tall: 32, r: 16, fillet: 8, pad: 12, most: 300 } as const;

const slots = (dots: number, slot: number, gap: number) => {
  const n = Math.max(1, dots);
  return n * slot + (n - 1) * gap;
};

/** The tab's straight body between its flares. */
export const tabBody = (dots: number) =>
  TAB.pad + slots(dots, TAB.slot, TAB.gap);

/** How long the tab is along its edge, flares and all: docksize.rs's tab_long. */
export const tabLong = (dots: number) => 2 * TAB.flare + tabBody(dots);

/** The open column's straight part, which holds its icons. */
export const notchBody = (dots: number) =>
  2 * NOTCH.pad +
  4 * NOTCH.button +
  2 * NOTCH.sep +
  Math.max(1, dots) * NOTCH.dot;

/** How long the open notch is along its edge, flares and all. */
export const notchLong = (dots: number) => 2 * NOTCH.flare + notchBody(dots);

const NS = "http://www.w3.org/2000/svg";

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

export type IconName = "inbox" | "more" | "mic" | "point";

const line = {
  fill: "none",
  stroke: "currentColor",
  "stroke-width": 1.7,
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
};

/** Each icon's shapes, on an 18 px grid. */
const ICONS: Record<
  IconName,
  [keyof SVGElementTagNameMap, Record<string, string | number>][]
> = {
  // A tray: a rounded box with a shelf that dips in the middle.
  inbox: [
    ["rect", { x: 2.6, y: 3, width: 12.8, height: 12, rx: 2.8, ...line }],
    ["path", { d: "M2.6 10.2h3.5l1.1 1.9h3.6l1.1-1.9h3.5", ...line }],
  ],
  more: [
    ["circle", { cx: 4.2, cy: 9, r: 1.55, fill: "currentColor" }],
    ["circle", { cx: 9, cy: 9, r: 1.55, fill: "currentColor" }],
    ["circle", { cx: 13.8, cy: 9, r: 1.55, fill: "currentColor" }],
  ],
  mic: [
    ["rect", { x: 6.4, y: 1.8, width: 5.2, height: 9.2, rx: 2.6, ...line }],
    ["path", { d: "M3.8 8.6a5.2 5.2 0 0 0 10.4 0M9 13.8v2.4", ...line }],
  ],
  point: [
    [
      "path",
      {
        d: "M2.4 7.2a2 2 0 0 1 2-2h1.8l1.2-1.8h3.2l1.2 1.8h1.8a2 2 0 0 1 2 2v6.4a2 2 0 0 1-2 2H4.4a2 2 0 0 1-2-2z",
        ...line,
      },
    ],
    ["circle", { cx: 9, cy: 10.2, r: 2.6, ...line }],
  ],
};

/** An icon `size` px across, in the text's colour, hidden from screen readers. */
export function icon(name: IconName, size: number): SVGSVGElement {
  const s = svg("svg", { viewBox: "0 0 18 18", width: size, height: size });
  s.setAttribute("aria-hidden", "true");
  for (const [tag, attrs] of ICONS[name]) s.append(svg(tag, attrs));
  return s;
}
