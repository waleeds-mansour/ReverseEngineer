// Holding an event on Calendar to move it: a press is a click (the popover opens) till the pointer
// moves a few px, and only then is the pointer captured; letting go drops it, and the click after
// a drag opens nothing. Esc, a release Nook never heard, the window losing focus, the capture taken
// away or the days changing under it put it back, never saved, and the next press works.
// Runs against a fake browser (no DOM here), as panes.test.ts does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalEvent } from "./types.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

let win: EventTarget & { setTimeout: typeof setTimeout };
beforeEach(() => {
  win = Object.assign(new EventTarget(), { setTimeout: globalThis.setTimeout });
  vi.stubGlobal("window", win);
});
afterEach(() => vi.unstubAllGlobals());

const rect = (top: number) => ({ top, left: 0, right: 50, bottom: top + 20 }) as DOMRect;

/** A block on the grid: it says when it captures the pointer, and where it's drawn. */
function block() {
  const el = Object.assign(new EventTarget(), {
    isConnected: true,
    top: 100,
    captured: false,
    setPointerCapture() {
      el.captured = true;
    },
    hasPointerCapture: () => el.captured,
    releasePointerCapture() {
      el.captured = false;
    },
    getBoundingClientRect: () => rect(el.top),
  });
  return el;
}

const send = (to: EventTarget, type: string, more: Record<string, unknown> = {}) => {
  const ev = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, ...more });
  to.dispatchEvent(ev);
  return ev;
};
const moveTo = (y: number, buttons = 1) =>
  send(win, "pointermove", { clientX: 10, clientY: y, buttons });
const release = (y: number) => send(win, "pointerup", { clientX: 10, clientY: y });
/** The click a browser sends after a release on the same element. */
const clicked = () => !send(win, "click").defaultPrevented;

const e = { id: "e1" } as CalEvent;

async function setup() {
  const { createRoot } = await import("solid-js");
  const { createDrag, holding } = await import("./calHold.ts");
  const drop = vi.fn();
  const drag = createRoot(() =>
    createDrag({
      // Down the grid as far as the pointer went: times as minutes from 0, for the test's sake.
      land: (g, _x, y) => ({
        start: new Date(y - g.y),
        end: new Date(y - g.y + 60),
        dx: 0,
        dy: y - g.y,
      }),
      drop,
    }),
  );
  const press = (el = block(), y = 100) => {
    drag.press(
      {
        button: 0,
        pointerType: "mouse",
        pointerId: 1,
        clientX: 10,
        clientY: y,
        currentTarget: el,
      } as unknown as PointerEvent,
      { e, mode: "move", day: new Date(2026, 9, 27) },
    );
    return el;
  };
  return { drag, drop, press, holding };
}

describe("a press", () => {
  it("is a click till it moves past a few px, and captures nothing", async () => {
    const { drop, press, holding } = await setup();
    const el = press();
    moveTo(103);
    expect(el.captured).toBe(false);
    expect(holding()).toBe(false);
    release(103);
    expect(clicked()).toBe(true);
    expect(drop).not.toHaveBeenCalled();
  });

  it("drags once it moves, drops where it's let go, and the click after opens nothing", async () => {
    const { drag, drop, press, holding } = await setup();
    const el = press();
    moveTo(130);
    expect(el.captured).toBe(true);
    expect(holding()).toBe(true);
    expect(drag.held()).toMatchObject({ dy: 30 });
    release(130);
    expect(drop).toHaveBeenCalledWith(e, { start: new Date(30), end: new Date(90) }, rect(100));
    expect(holding()).toBe(false);
    expect(el.captured).toBe(false);
    expect(clicked()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(clicked()).toBe(true);
  });
});

describe("put back, never saved", () => {
  it("on Esc, and the release after opens nothing", async () => {
    const { drag, drop, press, holding } = await setup();
    press();
    moveTo(130);
    const esc = send(win, "keydown", { key: "Escape" });
    expect(esc.defaultPrevented).toBe(true);
    expect(drag.held()).toBeUndefined();
    expect(holding()).toBe(false);
    moveTo(160);
    expect(drag.held()).toBeUndefined();
    release(160);
    expect(drop).not.toHaveBeenCalled();
    expect(clicked()).toBe(false);
  });

  it("when the button came up where Nook didn't hear it, and the next press still works", async () => {
    const { drop, press, holding } = await setup();
    press();
    moveTo(130);
    moveTo(140, 0);
    expect(holding()).toBe(false);
    release(140);
    expect(drop).not.toHaveBeenCalled();
    press();
    moveTo(120);
    release(120);
    expect(drop).toHaveBeenCalledTimes(1);
  });

  it("when the window loses focus", async () => {
    const { drop, press, holding } = await setup();
    press();
    moveTo(130);
    send(win, "blur");
    expect(holding()).toBe(false);
    release(130);
    expect(drop).not.toHaveBeenCalled();
  });

  it("when its capture is taken away", async () => {
    const { drop, press } = await setup();
    const el = press();
    moveTo(130);
    send(el, "lostpointercapture");
    release(130);
    expect(drop).not.toHaveBeenCalled();
  });

  it("when the days shown change under it", async () => {
    const { drag, drop, press } = await setup();
    press();
    moveTo(130);
    drag.cancel();
    expect(drag.held()).toBeUndefined();
    release(130);
    expect(drop).not.toHaveBeenCalled();
    expect(clicked()).toBe(false);
  });

  it("when a press starts before the last one's release was heard", async () => {
    const { drop, press } = await setup();
    press();
    moveTo(130);
    press();
    release(100);
    expect(drop).not.toHaveBeenCalled();
  });
});

it("drops beside where it was last drawn when the grid drew it again meanwhile", async () => {
  const { drop, press } = await setup();
  const el = press();
  el.top = 130;
  moveTo(130);
  // Read again mid-drag: its block is a new element now, and this one has left the page.
  el.isConnected = false;
  el.top = 0;
  send(el, "lostpointercapture");
  moveTo(145);
  release(145);
  expect(drop).toHaveBeenCalledWith(e, { start: new Date(45), end: new Date(105) }, rect(130));
});
