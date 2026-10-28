// The agent dock's sizes and drawn shapes (dockView.ts). The sizes are docksize.rs's, in CSS px, so
// the page lays out exactly the window Nook makes for it: the edge tab, 25 px out from the side of
// the screen, whose straight body grows with its dots between two 22 px flares, and the open pill,
// a column of 34 px capsules 14 px in from the edge. The tab's outline is our own: each flare is a
// cubic curve from the screen's edge, where it leaves the edge going straight along it, to the
// body, which it meets going straight along too, with both handles at 85 % of the flare's length,
// so the tab grows out of the edge with no corner anywhere. It is drawn for the right edge and
// mirrored for the left. The icons (the Inbox tray, "…", the mic and the camera) are drawn here
// too, with createElementNS, since Nook's pages allow no inline markup or styles.

import type { Edge } from "@/bindings";

/** The edge tab: docksize.rs's TAB_* consts. */
export const TAB = {
  deep: 25,
  flare: 22,
  slot: 13,
  gap: 9,
  pad: 25,
  room: [14, 20],
} as const;

/** The open pill and its label: docksize.rs's PILL_*, AGENT_*, TOOLS_LONG and LABEL_* consts. */
export const PILL = {
  inset: 14,
  wide: 34,
  gap: 8,
  button: 34,
  agentsPad: 12,
  slot: 11,
  slotGap: 9,
  tools: 11 + 18 + 12 + 17 + 11,
  labelGap: 12,
  labelWide: 300,
  room: [24, 30],
} as const;

const slots = (dots: number, slot: number, gap: number) => {
  const n = Math.max(1, dots);
  return n * slot + (n - 1) * gap;
};

/** How long the tab is along its edge, flares and all. */
export const tabLong = (dots: number) =>
  2 * TAB.flare + TAB.pad + slots(dots, TAB.slot, TAB.gap);

/** How long the open pill is. */
export const pillLong = (dots: number) =>
  2 * PILL.button +
  3 * PILL.gap +
  2 * PILL.agentsPad +
  slots(dots, PILL.slot, PILL.slotGap) +
  PILL.tools;

/** The dock's window, wide by long, at rest and with the pill open, as Nook makes it. */
export function windowSize(dots: number, open: boolean): [number, number] {
  const rest = tabLong(dots) + 2 * TAB.room[1];
  if (!open) return [TAB.deep + TAB.room[0], rest];
  const wide =
    PILL.inset + PILL.wide + PILL.labelGap + PILL.labelWide + PILL.room[0];
  return [wide, Math.max(rest, pillLong(dots) + 2 * PILL.room[1])];
}

const n = (v: number) => String(Math.round(v * 100) / 100);

/** The tab's outline, `long` px along the edge, in a box TAB.deep wide. */
export function tabPath(long: number, edge: Edge): string {
  const { deep: w, flare: f } = TAB;
  const h = 0.85 * f;
  const end = long - f;
  // x for the right edge, where x = w is the screen's edge; the left edge mirrors it.
  const x = (v: number) => n(edge === "left" ? w - v : v);
  return [
    `M${x(w)} 0`,
    `C${x(w)} ${n(h)} ${x(0)} ${n(f - h)} ${x(0)} ${n(f)}`,
    `L${x(0)} ${n(end)}`,
    `C${x(0)} ${n(end + h)} ${x(w)} ${n(long - h)} ${x(w)} ${n(long)}`,
    "Z",
  ].join(" ");
}

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
