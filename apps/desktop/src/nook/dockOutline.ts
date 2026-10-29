// The agent dock's notch as one outline (dockNotch.ts draws it every frame). It is worked out in
// the edge's own terms, d px in from the side of the screen and y px down the window, and mirrored
// onto the window for the right edge. The outline is a rectilinear polygon whose every corner is
// rounded by one cubic: the column, `deep` px in from the edge, and, beside it toward the middle of
// the screen, a box for a panel or a dot's label. Where the column leaves the edge, a concave corner
// on the edge and a convex one on the body make the S-shaped flare, with handles at 85 % along the
// edge so it leaves the screen's edge going straight along it, as the tab Nook keeps in the region
// does (dockclip.rs's flare). Where the box meets the column the corners are concave fillets, and
// its far corners are round. When two corners would overlap on the side between them, both shrink
// to fit it, so a box can grow out of the column from nothing. The box never reaches past the
// column's flares: the column grows to hold it.
//
// The window's region is made from this too (dockclip.rs): the flattened outline pushed out by
// ROOM px, or while it morphs, envelope()'s two boxes around everything it may cover until it
// settles.

/** How far the region reaches past the drawn outline: dockclip.rs's CLIP_ROOM. */
export const ROOM = 3;

/** The box beside the column, in y down the window, and how deep it reaches past the column. */
export interface NotchBox {
  wide: number;
  top: number;
  bottom: number;
  /** Its far corners. */
  r: number;
  /** Where it meets the column. */
  fillet: number;
}

/** What the outline is drawn from. */
export interface Notch {
  /** The middle of the column's straight part, down the window. */
  mid: number;
  deep: number;
  flare: number;
  /** The column's straight part, not counting a box it grows to hold. */
  body: number;
  box: NotchBox | null;
}

/** A point in from the edge (d) and down the window (y). */
export type Pt = readonly [number, number];

interface Corner {
  at: Pt;
  /** The directions in and out of it. */
  u: Pt;
  w: Pt;
  ra: number;
  ka: number;
  rb: number;
  kb: number;
}

const ROUND = 0.5523;
const FLARE_K = 0.85;
const DOWN: Pt = [0, 1];
const IN: Pt = [1, 0];
const OUT: Pt = [-1, 0];

/** Whether the box is there to draw. */
const hasBox = (n: Notch): n is Notch & { box: NotchBox } =>
  !!n.box && n.box.wide > 0.01 && n.box.bottom > n.box.top;

/** Where the whole notch starts and ends down the window, flares and all. */
export function extent(n: Notch): { top: number; bottom: number } {
  let top = n.mid - n.body / 2 - n.flare;
  let bottom = n.mid + n.body / 2 + n.flare;
  if (hasBox(n)) {
    top = Math.min(top, n.box.top - n.box.fillet - n.flare);
    bottom = Math.max(bottom, n.box.bottom + n.box.fillet + n.flare);
  }
  return { top, bottom };
}

const corner = (
  at: Pt,
  u: Pt,
  w: Pt,
  ra: number,
  ka: number,
  rb: number,
  kb: number,
): Corner => ({
  at,
  u,
  w,
  ra: Math.max(0, ra),
  ka,
  rb: Math.max(0, rb),
  kb,
});

/** The corners from the top of the edge round to its bottom, each fitting the sides it shares. */
export function corners(n: Notch): Corner[] {
  const { top, bottom } = extent(n);
  const d = Math.max(0, n.deep);
  const f = Math.max(0, n.flare);
  const yT = top + f / 2;
  const yB = bottom - f / 2;
  const all: Corner[] = [
    corner([0, yT], DOWN, IN, f / 2, FLARE_K, d / 2, 0.5),
    corner([d, yT], IN, DOWN, d / 2, 0.5, f / 2, FLARE_K),
  ];
  if (hasBox(n)) {
    const { wide, r, fillet } = n.box;
    const bt = n.box.top;
    const bb = n.box.bottom;
    all.push(
      corner([d, bt], DOWN, IN, fillet, ROUND, fillet, ROUND),
      corner([d + wide, bt], IN, DOWN, r, ROUND, r, ROUND),
      corner([d + wide, bb], DOWN, OUT, r, ROUND, r, ROUND),
      corner([d, bb], OUT, DOWN, fillet, ROUND, fillet, ROUND),
    );
  }
  all.push(
    corner([d, yB], DOWN, OUT, f / 2, FLARE_K, d / 2, 0.5),
    corner([0, yB], OUT, DOWN, d / 2, 0.5, f / 2, FLARE_K),
  );
  // Two corners never overlap on the side between them.
  for (let i = 0; i + 1 < all.length; i++) {
    const a = all[i];
    const b = all[i + 1];
    const side = Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1]);
    const want = a.rb + b.ra;
    if (want > side) {
      const k = want > 0 ? side / want : 0;
      a.rb *= k;
      b.ra *= k;
    }
  }
  return all;
}

type Seg = { kind: "line"; to: Pt } | { kind: "curve"; c1: Pt; c2: Pt; to: Pt };

const add = (p: Pt, v: Pt, k: number): Pt => [p[0] + v[0] * k, p[1] + v[1] * k];

/** The outline as a start and its pieces, from the top of the edge to its bottom. */
export function pieces(n: Notch): { from: Pt; segs: Seg[] } {
  const all = corners(n);
  const segs: Seg[] = [];
  const from = add(all[0].at, all[0].u, -all[0].ra);
  for (const c of all) {
    const s = add(c.at, c.u, -c.ra);
    const e = add(c.at, c.w, c.rb);
    segs.push({ kind: "line", to: s });
    segs.push({
      kind: "curve",
      c1: add(s, c.u, c.ka * c.ra),
      c2: add(e, c.w, -c.kb * c.rb),
      to: e,
    });
  }
  return { from, segs };
}

/** Which way the edge's d runs on the window: the right edge is mirrored. */
export interface Frame {
  /** The window's width, in CSS px. */
  wide: number;
  left: boolean;
}

/** A point of the notch on the window. */
export const onWindow = (fr: Frame, p: Pt): [number, number] => [
  fr.left ? p[0] : fr.wide - p[0],
  p[1],
];

const num = (v: number) => String(Math.round(v * 100) / 100);

/** The outline as SVG path data on the window: closed along the edge for the fill, open for the
 * hairline, which never runs along the edge. */
export function pathData(n: Notch, fr: Frame, closed: boolean): string {
  const { from, segs } = pieces(n);
  const at = (p: Pt) => onWindow(fr, p).map(num).join(" ");
  const out = [`M${at(from)}`];
  for (const s of segs) {
    out.push(
      s.kind === "line"
        ? `L${at(s.to)}`
        : `C${at(s.c1)} ${at(s.c2)} ${at(s.to)}`,
    );
  }
  if (closed) out.push("Z");
  return out.join(" ");
}

/** The outline as points, each curve cut into `steps` straight pieces, from the top of the edge
 * to its bottom, in the edge's terms. */
export function flatten(n: Notch, steps = 8): Pt[] {
  const { from, segs } = pieces(n);
  const pts: Pt[] = [from];
  let p = from;
  for (const s of segs) {
    if (s.kind === "line") pts.push(s.to);
    else {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const u = 1 - t;
        const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
        pts.push([
          k[0] * p[0] + k[1] * s.c1[0] + k[2] * s.c2[0] + k[3] * s.to[0],
          k[0] * p[1] + k[1] * s.c1[1] + k[2] * s.c2[1] + k[3] * s.to[1],
        ]);
      }
    }
    p = s.to;
  }
  // Pieces of no length say nothing about which way the outline runs.
  return pts.filter(
    (q, i) =>
      i === 0 || Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]) > 1e-6,
  );
}

/** The flattened outline pushed `room` px outward, closed along the edge `room` px past both ends:
 * what the window's region takes in for the notch once it has settled, on the window. */
export function region(n: Notch, fr: Frame, room = ROOM): [number, number][] {
  const pts = flatten(n);
  const dir = (a: Pt, b: Pt): Pt => {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  };
  // Outward is to the left of the way the outline runs, in the edge's terms (away from the edge
  // while it runs down the column).
  const normal = (v: Pt): Pt => [v[1], -v[0]];
  const out: Pt[] = [[0, pts[0][1] - room]];
  pts.forEach((p, i) => {
    const before = i > 0 ? normal(dir(pts[i - 1], p)) : null;
    const after = i + 1 < pts.length ? normal(dir(p, pts[i + 1])) : null;
    const a = before ?? after ?? ([1, 0] as Pt);
    const b = after ?? a;
    let m: Pt = [a[0] + b[0], a[1] + b[1]];
    const len = Math.hypot(m[0], m[1]);
    m = len > 1e-9 ? [m[0] / len, m[1] / len] : a;
    // A corner pushes out along its bisector, as far as it takes to stay `room` off both sides.
    const cos = Math.max(0.5, m[0] * a[0] + m[1] * a[1]);
    out.push([
      Math.max(0, p[0] + (m[0] * room) / cos),
      p[1] + (m[1] * room) / cos,
    ]);
  });
  out.push([0, pts[pts.length - 1][1] + room]);
  return out.map((p) => onWindow(fr, p));
}

/** The least and most a number of the notch reaches while it morphs. */
export interface Reach {
  lo: number;
  hi: number;
}

/**
 * Two boxes around every outline the notch may draw while it morphs between `shapes` (where it is,
 * where it goes, and the farthest its springs take it on the way), `room` px bigger: the column's
 * from the edge, and the box's beside it. They are what the window's region takes in until the
 * morph settles, so it never cuts off a frame of it.
 */
export function envelope(
  shapes: readonly Notch[],
  fr: Frame,
  room = ROOM,
): [number, number][][] {
  const rect = (d0: number, d1: number, y0: number, y1: number) =>
    (
      [
        [d0, y0],
        [d1, y0],
        [d1, y1],
        [d0, y1],
      ] as const
    ).map((p) => onWindow(fr, p));
  const spans = shapes.map(extent);
  const deep = Math.max(...shapes.map((n) => n.deep));
  const col = rect(
    0,
    deep + room,
    Math.min(...spans.map((s) => s.top)) - room,
    Math.max(...spans.map((s) => s.bottom)) + room,
  );
  const boxed = shapes.filter(hasBox);
  if (!boxed.length) return [col];
  const far = Math.max(...boxed.map((n) => n.deep + n.box.wide));
  const box = rect(
    0,
    far + room,
    Math.min(...boxed.map((n) => n.box.top)) - room,
    Math.max(...boxed.map((n) => n.box.bottom)) + room,
  );
  return [col, box];
}
