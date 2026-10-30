// The agent dock's springs (dockView.ts), as CSS can play them: a spring of a given stiffness and
// damping, with a mass of 1, is worked out here, sampled into a CSS linear() easing, and run for as
// long as it takes to settle. CSS then plays it as an ordinary transition, so nook.css's rule that
// stops every transition when Windows or the page asks for less motion stops these too, and a
// hidden page plays nothing. Three are used: the open pill springing in (380/32, barely past its
// mark), the tab springing back out of the edge as the pill closes and when the dock first shows
// (420/18, about 21 % past its mark before it settles), and the status label following the dot
// under the pointer (420/34).

import type { Tuning } from "./dockMotion";

/** Where a spring from 0 to 1 is after `t` seconds. */
export function springAt(
  stiffness: number,
  damping: number,
  t: number,
): number {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * w0 * t);
    return (
      1 - decay * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t))
    );
  }
  if (zeta === 1) return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
  const root = Math.sqrt(zeta * zeta - 1);
  const r1 = -w0 * (zeta - root);
  const r2 = -w0 * (zeta + root);
  return 1 + (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r1 - r2);
}

/** How far off its mark a spring may still be when it counts as settled. */
const SETTLED = 0.004;

/** How long, in seconds, until the spring stays within SETTLED of its mark. */
export function settleTime(stiffness: number, damping: number): number {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  // The swing's envelope: e^(-ζω0·t) / √(1 - ζ²) below critical damping.
  const swing = zeta < 1 ? 1 / Math.sqrt(1 - zeta * zeta) : 1;
  const rate = zeta < 1 ? zeta * w0 : w0 * (zeta - Math.sqrt(zeta * zeta - 1));
  return Math.log(swing / SETTLED) / rate;
}

/** The spring as a CSS easing, sampled `steps` times, and how long it runs in ms. */
export function springCss(
  stiffness: number,
  damping: number,
  steps = 48,
): { easing: string; ms: number } {
  const seconds = settleTime(stiffness, damping);
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const v =
      i === steps ? 1 : springAt(stiffness, damping, (seconds * i) / steps);
    points.push(String(Math.round(v * 10000) / 10000));
  }
  return {
    easing: `linear(${points.join(", ")})`,
    ms: Math.round(seconds * 1000),
  };
}

/** How far past its mark a spring swings, as a part of the way it goes. */
export function overshoot([k, c]: Tuning): number {
  const zeta = c / (2 * Math.sqrt(k));
  return zeta >= 1
    ? 0
    : Math.exp((-zeta * Math.PI) / Math.sqrt(1 - zeta * zeta));
}

/** The spring, damped more if it would swing past its mark by more than `most` of the way. */
export function swingAtMost(tuning: Tuning, most: number): Tuning {
  const [k] = tuning;
  if (overshoot(tuning) <= most) return tuning;
  if (most <= 0) return [k, 2 * Math.sqrt(k)];
  const l = Math.log(most);
  const zeta = -l / Math.sqrt(Math.PI * Math.PI + l * l);
  return [k, 2 * zeta * Math.sqrt(k)];
}

/** The dock's springs: stiffness and damping, by the name dock.css knows them by. */
export const SPRINGS = {
  panel: [380, 32],
  tab: [420, 18],
  general: [420, 34],
} as const;

/** Puts each spring on `root` as --spring-<name> and --spring-<name>-ms for dock.css. */
export function setSprings(root: HTMLElement): void {
  for (const [name, [k, c]] of Object.entries(SPRINGS)) {
    const { easing, ms } = springCss(k, c);
    root.style.setProperty(`--spring-${name}`, easing);
    root.style.setProperty(`--spring-${name}-ms`, `${ms}ms`);
  }
}
