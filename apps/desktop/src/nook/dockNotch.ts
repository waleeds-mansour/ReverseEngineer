// The agent dock's notch on screen (dockView.ts says where it should be): one black SVG path, drawn
// again every frame from numbers on springs, never two shapes crossfading. How open it is
// (dockLayout.ts's p) opens on 380/32 and closes on 420/18, which swings the tab a little back into
// the edge before it settles, never more than SWING_PX device px whatever the size; the box beside
// the column, for a panel or a dot's label, grows out of the column's top from nothing (a notice
// drops out of the tab this way, the column growing with it), morphs from one size to the next with
// its frame kept, and folds back into the column on 420/34, which never swings it out again. A
// label follows the dot under the pointer on 420/34. The dots and the count badge move with the
// shape, from the tab into the column; the column's buttons fade in as it opens, and a panel's
// content comes in from 14 px toward the edge on 380/32 (it leaves over 160 ms in dockPanels.ts).
// With less motion asked for, the shape is where it goes at once and what comes in fades in over
// 120 ms. Nothing moves while the page is hidden: it is put where it goes.
//
// The window's region follows (dockclip.rs): as a morph starts, two boxes around all it may cover
// until it settles (dockOutline.ts's envelope), and once it has, the outline itself, or nothing at
// rest, where Nook's own piece for the tab does. A morph from rest starts once Nook has set the
// region round it, so none of its frames is cut off.

import type { DockParts } from "./dockParts";
import {
  badgeAt,
  column,
  dotAt,
  items,
  morphShapes,
  openMid,
} from "./dockLayout";
import {
  envelope,
  type Frame,
  type Notch,
  type NotchBox,
  pathData,
  region,
} from "./dockOutline";
import { animator, Spring, type Ticker, type Tuning } from "./dockMotion";
import { LIP, NOTCH, TAB } from "./dockShape";
import { SPRINGS, swingAtMost } from "./dockSpring";

/** Where the notch should be. */
export interface Aim {
  /** The column, rather than the tab. */
  open: boolean;
  dots: number;
  /** The tab's middle down the window, from Nook. */
  mid: number;
  /** The window, in CSS px. */
  wide: number;
  high: number;
  left: boolean;
  box: { kind: "panel" | "lip"; at: NotchBox } | null;
}

export type Outline = [number, number][];

const FADE_S = 0.12;
const ENTER_X = 14;
/** The most a morph from rest waits for its region (ui.rs's REGION_WAIT). */
const REGION_WAIT_MS = 50;
/** Closing, the tab swings past its rest into the edge by at most this many device px, as it does
 * at 125 %: at 150 % and up its spring is damped more instead of swinging further. */
const SWING_PX = 7.5;
/** The tab's depth from open to closed, in CSS px: what its swing is a part of. */
const TAB_SWING = NOTCH.deep - TAB.deep;
const dpr = () => window.devicePixelRatio || 1;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function startNotch(
  ui: DockParts,
  {
    reduced,
    region: onRegion,
    ticker,
  }: {
    reduced: () => boolean;
    /** What the window's region takes in for the page's part, CSS px on the window: settles once
     * Nook has set it, or null when nothing new was sent. */
    region: (outlines: Outline[]) => Promise<void> | null;
    ticker?: Ticker;
  },
) {
  const p = new Spring(0);
  const box = {
    wide: new Spring(0),
    top: new Spring(0),
    bottom: new Spring(0),
    r: new Spring(0),
    fillet: new Spring(0),
  };
  const enter = new Spring(1);
  const all = [p, enter, ...Object.values(box)];
  const near = (s: Spring) => (s === p || s === enter ? 0.001 : 0.1);
  let aim: Aim | null = null;
  let content: HTMLElement | null = null;
  /** With less motion: how far through its 120 ms fade what just came in is. */
  let fade = 1;
  let sent = "";
  let aimed = "";

  const frameOf = (a: Aim): Frame => ({ wide: a.wide, left: a.left });
  const boxNow = (): NotchBox | null =>
    box.wide.value > 0.01 && box.bottom.value - box.top.value > 0.01
      ? {
          wide: box.wide.value,
          top: box.top.value,
          bottom: box.bottom.value,
          r: Math.max(0, box.r.value),
          fillet: Math.max(0, box.fillet.value),
        }
      : null;
  const notchAt = (a: Aim, open: number, b: NotchBox | null): Notch => ({
    ...column(open, a.dots, a.mid, a.high),
    box: b,
  });

  const send = (outlines: Outline[]): Promise<void> | null => {
    const key = JSON.stringify(outlines);
    if (key === sent) return null;
    sent = key;
    return onRegion(outlines);
  };

  /** Puts `e`'s middle at (d, y): in from the edge, down the window. */
  const place = (e: HTMLElement, a: Aim, d: number, y: number) => {
    const x = a.left ? d : a.wide - d;
    e.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) translate(-50%, -50%)`;
  };

  function draw() {
    const a = aim;
    if (!a) return;
    const fr = frameOf(a);
    const b = boxNow();
    const n = notchAt(a, p.value, b);
    ui.fill.setAttribute("d", pathData(n, fr, true));
    ui.line.setAttribute("d", pathData(n, fr, false));

    const dots = ui.dots.children;
    for (let i = 0; i < dots.length; i++) {
      const [d, y] = dotAt(i, a.dots, a.mid, a.high, p.value);
      place(dots[i] as HTMLElement, a, d, y);
    }
    const at = items(a.dots, openMid(a.dots, a.mid, a.high));
    const shown = clamp01((p.value - 0.45) / 0.55) * fade;
    ui.column.style.opacity = shown.toFixed(3);
    ui.column.style.visibility = shown > 0.01 ? "visible" : "hidden";
    const col = NOTCH.deep / 2;
    place(ui.inbox, a, col, at.inbox);
    place(ui.pip, a, col, at.pip);
    place(ui.talk, a, col, at.talk);
    place(ui.more, a, col, at.more);

    // The badge keeps its side toward the middle of the screen where it goes, and grows outward.
    const [bd, by] = badgeAt(a.dots, a.mid, a.high, p.value);
    const bx = a.left ? bd : a.wide - bd;
    ui.badge.style.transform = `translate(${bx.toFixed(2)}px, ${by.toFixed(2)}px)${a.left ? " translateX(-100%)" : ""}`;

    if (b) {
      const x0 = a.left ? n.deep : a.wide - n.deep - b.wide;
      ui.box.style.transform = `translate(${x0.toFixed(2)}px, ${b.top.toFixed(2)}px)`;
      ui.box.style.width = `${b.wide.toFixed(2)}px`;
      ui.box.style.height = `${(b.bottom - b.top).toFixed(2)}px`;
      ui.box.style.setProperty("--r", `${b.r.toFixed(2)}px`);
      ui.box.style.visibility = "visible";
    } else ui.box.style.visibility = "hidden";
    if (content) {
      const e = reduced() ? fade : enter.value;
      content.style.opacity = clamp01(e).toFixed(3);
      const x = (a.left ? -1 : 1) * ENTER_X * (1 - e);
      content.style.translate = `${x.toFixed(2)}px 0`;
    }
  }

  /** Where it goes, and the region round the whole morph there, or round where it settled. */
  function settle() {
    const a = aim;
    if (!a) return;
    const b = boxNow();
    if (p.value === 0 && !b) send([]);
    else send([region(notchAt(a, p.value, b), frameOf(a))]);
  }

  function covering(): Promise<void> | null {
    const a = aim;
    if (!a) return null;
    const span = (s: Spring) => s.reach(near(s));
    const shapes = morphShapes(
      a.dots,
      a.mid,
      a.high,
      { ...span(p), now: p.value, to: p.target },
      {
        wide: span(box.wide),
        top: span(box.top),
        bottom: span(box.bottom),
        r: box.r.target,
        fillet: box.fillet.target,
      },
    );
    return send(envelope(shapes, frameOf(a)));
  }

  let fadeLeft = 0;
  const run = animator((dt) => {
    if (fadeLeft > 0) {
      fadeLeft = Math.max(0, fadeLeft - dt);
      fade = 1 - fadeLeft / FADE_S;
    }
    // Less motion asked for mid-morph: it is where it goes at once, and the frames stop.
    if (reduced()) for (const s of all) s.snap();
    else for (const s of all) s.step(dt);
    const still = all.every((s) => s.settled(near(s)));
    if (still) for (const s of all) s.snap();
    draw();
    if (still) settle();
    return !still || fadeLeft > 0;
  }, ticker);

  /** The latest hold's number while a morph waits for its region, else 0. */
  let holding = 0;
  let holds = 0;
  const go = () => {
    if (!holding) run.kick();
  };
  /** A morph from rest waits for Nook to set the region round it, at most REGION_WAIT_MS: its first
   * frames would otherwise be cut to the old region, a hiccup that grew with the dock's size. */
  function hold(set: Promise<void>) {
    const mine = ++holds;
    holding = mine;
    const release = () => {
      if (holding !== mine) return;
      holding = 0;
      run.kick();
    };
    void set.then(release, release);
    setTimeout(release, REGION_WAIT_MS);
  }

  /** Puts every spring where it goes, at once. */
  function jump() {
    for (const s of all) s.snap();
    fade = 1;
    fadeLeft = 0;
    draw();
    settle();
  }

  const tune = (open: boolean): Tuning =>
    open
      ? SPRINGS.panel
      : swingAtMost(SPRINGS.tab, SWING_PX / TAB_SWING / dpr());
  /** How tall a box is as it comes out of the column or goes back in: the column's straight part
   * beside it, but never less than a label. */
  const stub = (a: Aim, b: NotchBox) => {
    const col = column(a.open ? 1 : 0, a.dots, a.mid, a.high);
    return Math.max(LIP.tall, col.body - 2 * b.fillet);
  };

  return {
    /** Sends the notch where `a` says, from wherever it is now. */
    aim(a: Aim) {
      const key = JSON.stringify(a);
      if (key === aimed) return;
      aimed = key;
      const was = aim;
      aim = a;
      const opening = a.open && p.target !== 1;
      p.to(a.open ? 1 : 0, tune(a.open));
      const b = a.box;
      if (b) {
        const kind = b.kind;
        const tuning: Tuning =
          kind === "lip" && was?.box?.kind === "lip"
            ? SPRINGS.general
            : SPRINGS.panel;
        if (box.wide.value < 0.5) {
          // From nothing: a label slides out at its dot, and a panel out of the column's top,
          // as tall as the column's straight part to start with, growing down as it comes.
          box.top.snap(b.at.top);
          box.bottom.snap(Math.min(b.at.bottom, b.at.top + stub(a, b.at)));
          box.r.snap(b.at.r);
          box.fillet.snap(b.at.fillet);
        }
        box.wide.to(b.at.wide, tuning);
        box.top.to(b.at.top, tuning);
        box.bottom.to(b.at.bottom, tuning);
        box.r.to(b.at.r, tuning);
        box.fillet.to(b.at.fillet, tuning);
      } else if (box.wide.target !== 0) {
        // Folding back in, it doesn't swing out again past the column.
        box.wide.to(0, SPRINGS.general);
        if (was?.box?.kind === "panel") {
          const at = { ...was.box.at, top: box.top.target };
          box.bottom.to(at.top + stub(a, at), SPRINGS.general);
        }
      }
      if (!was || document.visibilityState !== "visible") {
        jump();
        return;
      }
      if (reduced()) {
        if (opening) {
          fadeLeft = FADE_S;
          fade = 0;
        }
        for (const s of all) s.snap();
      }
      const set = covering();
      if (set && !run.running()) hold(set);
      else go();
    },
    /** A panel's content just came into the box: it comes in from toward the edge. */
    entering(e: HTMLElement | null) {
      content = e;
      if (!e) return;
      if (reduced()) {
        fadeLeft = FADE_S;
        fade = 0;
      } else {
        enter.snap(0);
        enter.to(1, SPRINGS.panel);
      }
      draw();
      // The aim that follows may hold the frames for its region; with none, they start here.
      queueMicrotask(go);
    },
    /** The page was hidden: it is put where it goes. */
    jump,
    /** Whether the column is out, or on its way out. */
    opened: () => p.target === 1,
    /** Whether anything still moves: the dots may be sliding under a pointer that stays put. */
    moving: () => run.running() || holding !== 0,
    /** Draws it again where it is, after the dots changed. */
    redraw: () => {
      draw();
      if (!run.running() && !holding) settle();
    },
  };
}

export type NotchView = ReturnType<typeof startNotch>;
