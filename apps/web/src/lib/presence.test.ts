// Something that closes stays on screen, marked closed, for Nook's fast step so it can fade, then
// goes; opening it again while it leaves keeps it; and with less motion asked for it goes at once.
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DURATIONS } from "../styles/themes.ts";
import { createPresence, prefersReducedMotion, presenceStep } from "./presence.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

describe("a presence step", () => {
  it("mounts and opens at once", () => {
    expect(presenceStep({ mounted: false, state: "closed" }, true)).toEqual({
      mounted: true,
      state: "open",
      wait: false,
    });
  });

  it("closes but stays mounted, and starts the wait, when an open one closes", () => {
    expect(presenceStep({ mounted: true, state: "open" }, false)).toEqual({
      mounted: true,
      state: "closed",
      wait: true,
    });
  });

  it("keeps the wait it has when one already leaving is told to close again", () => {
    expect(presenceStep({ mounted: true, state: "closed" }, false)).toEqual({
      mounted: true,
      state: "closed",
      wait: false,
    });
  });

  it("stays gone when one that isn't there closes", () => {
    expect(presenceStep({ mounted: false, state: "closed" }, false)).toEqual({
      mounted: false,
      state: "closed",
      wait: false,
    });
  });

  it("opens one that's leaving again", () => {
    expect(presenceStep({ mounted: true, state: "closed" }, true).state).toBe("open");
  });
});

describe("a presence", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** A presence on a signal, inside a root, with the timers faked. */
  function watch(initial: boolean, ms?: number) {
    vi.useFakeTimers();
    return createRoot((dispose) => {
      const [open, setOpen] = createSignal(initial);
      const p = createPresence(open, ms);
      return { ...p, setOpen, dispose };
    });
  }

  it("starts as its signal is", () => {
    const shut = watch(false);
    expect([shut.mounted(), shut.state()]).toEqual([false, "closed"]);
    shut.dispose();
    const shown = watch(true);
    expect([shown.mounted(), shown.state()]).toEqual([true, "open"]);
    shown.dispose();
  });

  it("stays mounted, closed, for the fast step after it closes, then goes", () => {
    const p = watch(true);
    p.setOpen(false);
    expect([p.mounted(), p.state()]).toEqual([true, "closed"]);
    vi.advanceTimersByTime(DURATIONS.fast - 1);
    expect(p.mounted()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(p.mounted()).toBe(false);
    p.dispose();
  });

  it("keeps the same element when it opens again while leaving", () => {
    const p = watch(true, 100);
    p.setOpen(false);
    vi.advanceTimersByTime(50);
    p.setOpen(true);
    vi.advanceTimersByTime(500);
    expect([p.mounted(), p.state()]).toEqual([true, "open"]);
    p.dispose();
  });

  it("mounts at once when it opens", () => {
    const p = watch(false);
    p.setOpen(true);
    expect([p.mounted(), p.state()]).toEqual([true, "open"]);
    p.dispose();
  });

  it("goes at once when the system asks for less motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce") }));
    expect(prefersReducedMotion()).toBe(true);
    const p = watch(true);
    p.setOpen(false);
    expect(p.mounted()).toBe(false);
    p.dispose();
  });

  it("goes at once with no wait asked for", () => {
    const p = watch(true, 0);
    p.setOpen(false);
    expect(p.mounted()).toBe(false);
    p.dispose();
  });

  it("asks for no less motion where there's no window", () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});
