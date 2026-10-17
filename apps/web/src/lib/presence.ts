// Keeps something on screen while it leaves. A menu, toast or sheet that closes stays mounted for
// Nook's fast step with data-state="closed", which styles/kit/motion.css fades (or a component's
// own data-[state=closed]: utility animates), and only then goes. When the system asks for less
// motion it goes at once. Opening again while it leaves keeps the same element.

import { batch, createEffect, createSignal, on, onCleanup, untrack } from "solid-js";
import { DURATIONS } from "../styles/themes.ts";

export type PresenceState = "open" | "closed";

interface Presence {
  mounted: boolean;
  state: PresenceState;
}

/**
 * The next state when `open` changes. `wait` says to start the exit: stay mounted, closed, for
 * the exit's length, then unmount. Something already leaving keeps the wait it has.
 */
export function presenceStep(s: Presence, open: boolean): Presence & { wait: boolean } {
  if (open) return { mounted: true, state: "open", wait: false };
  if (s.mounted && s.state === "open") return { mounted: true, state: "closed", wait: true };
  return { mounted: s.mounted, state: "closed", wait: false };
}

/** Whether the system asks for less motion; false where there's no window to ask. */
export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * Whether to render something shown when `open()`, and the state its data-state says. It stays
 * mounted `ms` (the fast step) after `open()` turns false, or none under reduced motion.
 */
export function createPresence(
  open: () => boolean,
  ms: number = DURATIONS.fast,
): { mounted: () => boolean; state: () => PresenceState } {
  const first = untrack(open);
  const [mounted, setMounted] = createSignal(first);
  const [state, setState] = createSignal<PresenceState>(first ? "open" : "closed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gone = () => {
    if (untrack(state) === "closed") setMounted(false);
  };

  createEffect(
    on(
      open,
      (now) => {
        const next = presenceStep({ mounted: untrack(mounted), state: untrack(state) }, now);
        if (now) clearTimeout(timer);
        batch(() => {
          setMounted(next.mounted);
          setState(next.state);
        });
        if (!next.wait) return;
        const wait = prefersReducedMotion() ? 0 : ms;
        if (wait > 0) timer = setTimeout(gone, wait);
        else gone();
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));

  return { mounted, state };
}
