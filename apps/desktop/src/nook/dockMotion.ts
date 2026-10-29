// What moves the agent dock's notch (dockNotch.ts): numbers on springs, stepped every frame, from
// which the notch's one outline is drawn again. A spring keeps its speed when it is sent somewhere
// new mid-way, so a notch that opens and closes again before it settles turns round smoothly. Each
// can say how far it will go before it settles, worked out by running a copy of it ahead, so the
// window's region can take in the whole morph before it starts (dockOutline.ts's envelope). The
// frames come from a ticker, requestAnimationFrame in Hearth's app, which stops while the page is
// hidden; the preview's film strips step one by hand (preview/dock.ts).

/** A spring's stiffness and damping, with a mass of 1: dockSpring.ts's SPRINGS. */
export type Tuning = readonly [number, number];

/** Steps no longer than this, so a stiff spring stays stable however late a frame comes. */
const STEP = 1 / 240;

export class Spring {
  value: number;
  velocity = 0;
  target: number;
  private k = 380;
  private c = 32;

  constructor(value: number) {
    this.value = value;
    this.target = value;
  }

  /** Sends it to `target` on `tuning`, from where it is now and as fast as it is going. */
  to(target: number, tuning: Tuning): void {
    this.target = target;
    [this.k, this.c] = tuning;
  }

  /** Puts it at `value` (its target, by default), still. */
  snap(value = this.target): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  step(dt: number): void {
    let left = Math.min(dt, 0.1);
    while (left > 1e-9) {
      const h = Math.min(STEP, left);
      const a = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += a * h;
      this.value += this.velocity * h;
      left -= h;
    }
  }

  /** Close enough to its target, and slow enough, to stop: within `near` and moving slower than
   * `near` per 50 ms. */
  settled(near: number): boolean {
    return (
      Math.abs(this.value - this.target) < near &&
      Math.abs(this.velocity) < near * 20
    );
  }

  /** The least and most it reaches from here before it settles within `near`. */
  reach(near: number): { lo: number; hi: number } {
    const copy = new Spring(this.value);
    copy.velocity = this.velocity;
    copy.to(this.target, [this.k, this.c]);
    let lo = Math.min(this.value, this.target);
    let hi = Math.max(this.value, this.target);
    for (let i = 0; i < 600 && !copy.settled(near); i++) {
      copy.step(1 / 120);
      lo = Math.min(lo, copy.value);
      hi = Math.max(hi, copy.value);
    }
    return { lo, hi };
  }
}

/** What runs the frames: requestAnimationFrame, or the preview's hand. */
export interface Ticker {
  request(cb: (now: number) => void): number;
  cancel(id: number): void;
}

export const frames: Ticker = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Calls `frame` with the seconds since the last frame, every frame while it says it still moves.
 * kick() starts it again after something changed; stop() ends it.
 */
export function animator(
  frame: (dt: number) => boolean,
  ticker: Ticker = frames,
) {
  let id = 0;
  let last = 0;
  const tick = (now: number) => {
    const dt = last ? Math.max(0, Math.min(0.05, (now - last) / 1000)) : 1 / 60;
    last = now;
    if (frame(dt)) id = ticker.request(tick);
    else {
      id = 0;
      last = 0;
    }
  };
  return {
    kick() {
      if (!id) id = ticker.request(tick);
    },
    stop() {
      if (id) ticker.cancel(id);
      id = 0;
      last = 0;
    },
    running: () => id !== 0,
  };
}
