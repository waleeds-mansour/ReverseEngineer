// The agent dock's notch outline and the window region made from it (dockOutline.ts, dockLayout.ts):
// in every state the region takes in all that is drawn, hairline and all, and nothing more than
// ROOM px past it, so the window never shows a piece of itself where nothing is painted (the white
// strip 1.0.46 had above the open column); the tab the page draws is the one Nook keeps in the
// region (dockclip.rs); the open notch stays inside the work area; and no frame of a morph reaches
// past the region sent as it starts. Run: bun src/nook/dockOutline.test.ts
import assert from "node:assert/strict";
import {
  column,
  dotAt,
  items,
  lipBox,
  morphShapes,
  openMid,
  panelBox,
} from "./dockLayout";
import { Spring, type Tuning } from "./dockMotion";
import {
  envelope,
  extent,
  flatten,
  type Frame,
  type Notch,
  onWindow,
  pathData,
  region,
  ROOM,
} from "./dockOutline";
import { LIP, NOTCH, PANEL, TAB, tabLong } from "./dockShape";
import { SPRINGS } from "./dockSpring";

type P = [number, number];

/** How many times `poly` winds round `p`, as Windows fills a polygon region. */
function winding(poly: readonly P[], p: P): number {
  let n = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    const side = (x1 - x0) * (p[1] - y0) - (p[0] - x0) * (y1 - y0);
    if (y0 <= p[1] && y1 > p[1] && side > 0) n++;
    else if (y0 > p[1] && y1 <= p[1] && side < 0) n--;
  }
  return n;
}
const inside = (poly: readonly P[], p: P) => winding(poly, p) !== 0;

/** How far `p` is from the closed polygon's outline. */
function away(poly: readonly P[], p: P): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len = dx * dx + dy * dy;
    const t = len
      ? Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len),
        )
      : 0;
    best = Math.min(
      best,
      Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy),
    );
  }
  return best;
}

/** What is drawn: the outline, closed along the edge, on the window. */
const drawn = (n: Notch, fr: Frame): P[] =>
  flatten(n, 16).map((q) => onWindow(fr, q));

const WIDE = 520;
const HIGH = 960;
const DOTS = 3;

/** Every state the notch settles in, on both edges and with the tab high, middling and low. */
function states(): [string, Notch, Frame][] {
  const out: [string, Notch, Frame][] = [];
  for (const left of [false, true]) {
    const fr: Frame = { wide: WIDE, left };
    // As high and low as Nook puts the tab's middle: 12 px from the ends of the work area.
    for (const mid of [
      tabLong(DOTS) / 2 + NOTCH.room,
      480,
      HIGH - tabLong(DOTS) / 2 - NOTCH.room,
    ]) {
      const rest = column(0, DOTS, mid, HIGH);
      const open = column(1, DOTS, mid, HIGH);
      const at = items(DOTS, openMid(DOTS, mid, HIGH));
      const name = (s: string) => `${s} ${left ? "left" : "right"} ${mid}`;
      out.push([name("rest"), rest, fr]);
      out.push([name("open"), open, fr]);
      out.push([
        name("lip"),
        { ...open, box: lipBox(open, at.dots[1], 180) },
        fr,
      ]);
      out.push([
        name("lip, top dot"),
        { ...open, box: lipBox(open, at.dots[0], 300) },
        fr,
      ]);
      out.push([
        name("menu"),
        { ...open, box: panelBox(open, 236, 256, HIGH) },
        fr,
      ]);
      out.push([
        name("stub panel"),
        { ...open, box: panelBox(open, 360, 240, HIGH) },
        fr,
      ]);
      out.push([
        name("tallest panel"),
        { ...open, box: panelBox(open, 420, 640, HIGH) },
        fr,
      ]);
      out.push([
        name("notice"),
        { ...rest, box: panelBox(rest, 320, 64, HIGH) },
        fr,
      ]);
    }
  }
  return out;
}

for (const [name, n, fr] of states()) {
  const shape = drawn(n, fr);
  const room = region(n, fr) as P[];
  assert.ok(room.length <= 800, `${name}: at most 800 points for Nook`);
  assert.ok(
    room.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])),
    name,
  );
  // All that is drawn is in the region: the fill, and the hairline half a px past the outline.
  for (const q of flatten(n, 16)) {
    if (q[0] < 1) continue;
    const p = onWindow(fr, q);
    assert.ok(inside(room, p), `${name}: the outline at ${p} is in the region`);
    // Off the screen's edge, where the window ends anyway, the hairline is well inside it.
    if (q[0] >= ROOM) {
      assert.ok(
        away(room, p) >= 2,
        `${name}: the hairline at ${p} is well inside it`,
      );
    }
  }
  const { top, bottom } = extent(n);
  const far = n.deep + (n.box?.wide ?? 0) + 2;
  for (let y = Math.floor(top); y <= bottom; y += 3) {
    for (let d = 0.5; d <= far; d += 3) {
      const [x] = onWindow(fr, [d, y]);
      if (inside(shape, [x, y])) {
        assert.ok(
          inside(room, [x, y]),
          `${name}: ${x},${y} is drawn and in the region`,
        );
      }
    }
  }
  // And the region is never more than ROOM px past what is drawn (and a little for the curves).
  for (const p of room) {
    const off = inside(shape, p) ? 0 : away(shape, p);
    assert.ok(
      off <= ROOM + 0.75,
      `${name}: the region's ${p} is ${off} px off what is drawn`,
    );
  }
  // Nothing past the window but the edge it sits on, and no notch nearer the work area's top or
  // bottom than NOTCH.room, unless the tab itself is (Nook keeps it 12 px in at 150 %).
  for (const p of room) {
    assert.ok(p[0] >= 0 && p[0] <= WIDE, `${name}: ${p} is in the window`);
  }
  if (n.deep === NOTCH.deep) {
    assert.ok(
      top >= NOTCH.room - 1e-6 && bottom <= HIGH - NOTCH.room + 1e-6,
      `${name}: ${top}..${bottom}`,
    );
  }
  // The fill and the hairline are one path each: the fill closes along the edge, the line doesn't.
  assert.match(pathData(n, fr, true), /Z$/);
  assert.doesNotMatch(pathData(n, fr, false), /Z/);
}

// The page's tab is Nook's: dockclip.rs keeps the tab's outline, its flares cut into 8 straight
// pieces and pushed ROOM px in from the edge and away from the tab's middle, before the page says
// anything.
function rustTab(mid: number, dots: number, fr: Frame): P[] {
  const f = TAB.flare;
  const h = 0.85 * f;
  const half = tabLong(dots) / 2;
  const flare = (t: number): P => {
    const u = 1 - t;
    return [
      3 * u * t * t * TAB.deep + t * t * t * TAB.deep,
      3 * u * u * t * h + 3 * u * t * t * (f - h) + t * t * t * f,
    ];
  };
  const steps = Array.from({ length: 9 }, (_, i) => flare(i / 8));
  const pts: P[] = [[0, mid - half - ROOM]];
  for (const [d, y] of steps) pts.push([d + ROOM, mid + y - half - ROOM]);
  for (const [d, y] of [...steps].reverse())
    pts.push([d + ROOM, mid + half - y + ROOM]);
  pts.push([0, mid + half + ROOM]);
  return pts.map((p) => onWindow(fr, p));
}
for (const left of [false, true]) {
  const fr: Frame = { wide: WIDE, left };
  for (const dots of [1, 2, 4]) {
    const tab = column(0, dots, 400, HIGH);
    const nook = rustTab(400, dots, fr);
    for (const q of flatten(tab, 16)) {
      if (q[0] < 0.5) continue;
      const p = onWindow(fr, q);
      assert.ok(inside(nook, p), `the tab's ${p} is in Nook's piece`);
      if (q[0] >= ROOM)
        assert.ok(away(nook, p) >= 1.5, `the tab's ${p} is well inside it`);
    }
    assert.equal(extent(tab).bottom - extent(tab).top, tabLong(dots));
  }
}

// A panel sits against the column, top-aligned with its straight part, PANEL.pad round its
// content; one too tall to fit below the tab moves up, the column growing to hold it.
const open = column(1, DOTS, 480, HIGH);
const menu = panelBox(open, 236, 256, HIGH);
assert.equal(menu.top, open.mid - open.body / 2 + PANEL.fillet);
assert.equal(menu.wide, 236 + 2 * PANEL.pad);
assert.equal(menu.bottom - menu.top, 256 + 2 * PANEL.pad);
const low = column(1, DOTS, 930, HIGH);
const tall = panelBox(low, 420, 640, HIGH);
assert.ok(tall.bottom + tall.fillet + low.flare <= HIGH - NOTCH.room + 1e-9);
assert.ok(
  extent({ ...low, box: tall }).top < extent(low).top,
  "the column grows up to it",
);
// A lip is LIP.tall at its dot, and a notice drops beside the tab itself.
const lip = lipBox(open, items(DOTS, open.mid).dots[2], 150);
assert.equal(lip.bottom - lip.top, LIP.tall);
assert.equal((lip.top + lip.bottom) / 2, items(DOTS, open.mid).dots[2]);
const rest = column(0, DOTS, 480, HIGH);
const notice = panelBox(rest, 320, 64, HIGH);
assert.equal(notice.top, rest.mid - rest.body / 2 + PANEL.fillet);
// Closing, only the depth swings past the tab: it sinks into the edge and springs back out, while
// its length stays the tab's, with the dots in it.
const sunk = column(-0.2, DOTS, 480, HIGH);
assert.ok(sunk.deep < TAB.deep);
assert.equal(sunk.body, rest.body);
assert.equal(
  dotAt(2, DOTS, 480, HIGH, -0.2)[1],
  dotAt(2, DOTS, 480, HIGH, 0)[1],
);
// The dots move from the tab into the column: at rest a pixel toward the edge of the tab's middle.
assert.deepEqual(dotAt(0, 1, 480, HIGH, 0), [TAB.deep / 2 - 1, 480]);
assert.deepEqual(dotAt(0, 1, 480, HIGH, 1), [
  NOTCH.deep / 2,
  items(1, 480).dots[0],
]);

// No frame of a morph reaches past the region sent as it starts: the notch opening with the
// Inbox, closing with its bounce, a label moving to the next dot, and a notice dropping and
// folding back, on both edges.
function morph(
  name: string,
  from: Notch,
  to: Notch,
  fr: Frame,
  tuning: Tuning,
) {
  const p = new Spring(from.deep === NOTCH.deep ? 1 : 0);
  p.to(to.deep === NOTCH.deep ? 1 : 0, tuning);
  // A box comes out of the column, and goes back in, as tall as the column's straight part
  // (dockNotch.ts's stub).
  const nothing = { wide: 0, top: 0, bottom: 0, r: 0, fillet: 0 };
  const stub = (n: Notch, fillet: number) =>
    Math.max(LIP.tall, n.body - 2 * fillet);
  const t = to.box?.top ?? 0;
  const a = from.box ?? {
    ...nothing,
    top: t,
    bottom: Math.min(to.box?.bottom ?? t, t + stub(to, to.box?.fillet ?? 0)),
  };
  const b = to.box ?? {
    ...nothing,
    top: a.top,
    bottom: a.top + stub(to, a.fillet),
  };
  const box = (k: keyof typeof a) => {
    const s = new Spring(a[k]);
    s.to(b[k], tuning);
    return s;
  };
  const wide = box("wide");
  const top = box("top");
  const bottom = box("bottom");
  const span = (s: Spring, near: number) => s.reach(near);
  const shapes = morphShapes(
    DOTS,
    480,
    HIGH,
    { ...span(p, 0.001), now: p.value, to: p.target },
    {
      wide: span(wide, 0.1),
      top: span(top, 0.1),
      bottom: span(bottom, 0.1),
      // A folding box keeps its corners (dockNotch.ts leaves them where they were).
      r: b.r || a.r,
      fillet: b.fillet || a.fillet,
    },
  );
  const cover = envelope(shapes, fr) as P[][];
  for (let i = 0; i < 180; i++) {
    for (const s of [p, wide, top, bottom]) s.step(1 / 60);
    const w = wide.value;
    const n: Notch = {
      ...column(p.value, DOTS, 480, HIGH),
      box:
        w > 0.01 && bottom.value > top.value
          ? {
              wide: w,
              top: top.value,
              bottom: bottom.value,
              r: b.r || a.r,
              fillet: b.fillet || a.fillet,
            }
          : null,
    };
    for (const q of flatten(n, 8)) {
      const pt = onWindow(fr, q);
      assert.ok(
        cover.some((c) => inside(c, pt) || away(c, pt) < 1e-6),
        `${name}, frame ${i}: ${pt} is in the region`,
      );
    }
  }
}
for (const left of [false, true]) {
  const fr: Frame = { wide: WIDE, left };
  const shut = column(0, DOTS, 480, HIGH);
  const out = column(1, DOTS, 480, HIGH);
  const at = items(DOTS, out.mid);
  morph("open", shut, out, fr, SPRINGS.panel);
  morph("close", out, shut, fr, SPRINGS.tab);
  morph(
    "inbox",
    out,
    { ...out, box: panelBox(out, 380, 300, HIGH) },
    fr,
    SPRINGS.panel,
  );
  morph(
    "next dot",
    { ...out, box: lipBox(out, at.dots[0], 120) },
    { ...out, box: lipBox(out, at.dots[2], 220) },
    fr,
    SPRINGS.general,
  );
  morph(
    "notice drops",
    shut,
    { ...shut, box: panelBox(shut, 320, 64, HIGH) },
    fr,
    SPRINGS.panel,
  );
  morph(
    "notice folds",
    { ...shut, box: panelBox(shut, 320, 64, HIGH) },
    shut,
    fr,
    SPRINGS.general,
  );
}

console.log("dockOutline: all assertions passed");
