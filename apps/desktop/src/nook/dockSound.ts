// The agent dock's sounds (dockView.ts): three short tones of our own, made in the page with
// WebAudio, with no sound files. A soft two-note cue rising a fourth says something new waits for
// the owner (the count on the dock's badge went up: a new approval, or something Pip asks); a
// single low note says one of Hearth's services is in trouble (its dot came, or Pip stopped
// answering); a short note that glides up says Pip finished something. Each is a sine with a quiet
// octave above it, peaking at -18 dBFS, and every note swells in and fades out over about 150 ms so
// none of them clicks; the cue's second note swells exactly as the first fades, so together they
// never pass the peak either. The page decides when: never on its first draw, the first after it
// was hidden, or the first after its dots began or stopped coming from Hearth's feed (only on a
// change it saw happen from one source, so the feed coming back is no news), never while it is
// hidden, at most one a second, and only while the dock's menu has Sounds on. Chromium holds a
// page's audio until the page is pressed, and notes asked of a held context all play at once when
// it lets go, so until the dock has been pressed a sound is simply dropped; any press on the dock
// lets its audio start. Between sounds the context is suspended again, once the last note's tail
// has faded, so it costs nothing while it is quiet.

import type { AgentDot } from "@/bindings";

export type Cue = "asks" | "trouble" | "done";

/** -18 dBFS, as a gain. */
export const PEAK = 10 ** (-18 / 20);
/** At most one sound in this long. */
export const ONE_PER_MS = 1000;

/** One note: when it starts, the pitch it starts and ends on, and its envelope, in seconds. */
export interface Note {
  at: number;
  from: number;
  to: number;
  attack: number;
  hold: number;
  release: number;
}

const note = (
  at: number,
  from: number,
  to: number,
  hold: number,
  release = 0.15,
): Note => ({
  at,
  from,
  to,
  attack: 0.15,
  hold,
  release,
});

export const NOTES: Record<Cue, Note[]> = {
  // E5 then A5, the second swelling as the first fades.
  asks: [note(0, 659.25, 659.25, 0.02), note(0.17, 880, 880, 0.06, 0.18)],
  // A3, held a little longer.
  trouble: [note(0, 220, 220, 0.12, 0.22)],
  // D5 gliding up to A5.
  done: [note(0, 587.33, 880, 0.04)],
};

/** How loud `notes` are together `t` seconds in, as a gain. */
export function level(notes: readonly Note[], t: number): number {
  let sum = 0;
  for (const n of notes) {
    const s = t - n.at;
    if (s <= 0) continue;
    if (s < n.attack) sum += (PEAK * s) / n.attack;
    else if (s < n.attack + n.hold) sum += PEAK;
    else if (s < n.attack + n.hold + n.release)
      sum += PEAK * (1 - (s - n.attack - n.hold) / n.release);
  }
  return sum;
}

/** How many things wait for the owner, as the dock's badge counts them. */
export const waitingOf = (dots: readonly AgentDot[]) =>
  dots.reduce((sum, d) => sum + d.waiting, 0);

/** The sound a change from `before` to `after` calls for, if any; none without a `before`. */
export function cueFor(
  before: readonly AgentDot[] | null,
  after: readonly AgentDot[],
): Cue | null {
  if (!before) return null;
  if (waitingOf(after) > waitingOf(before)) return "asks";
  const had = new Set(
    before.filter((d) => d.kind === "service").map((d) => d.id),
  );
  if (after.some((d) => d.kind === "service" && !had.has(d.id)))
    return "trouble";
  const was = before.find((d) => d.kind === "pip");
  const now = after.find((d) => d.kind === "pip");
  // Pip needing the owner with nothing waiting is Pip not answering.
  const down = (d?: AgentDot) => d?.state === "needs_you" && d.waiting === 0;
  if (down(now) && !down(was)) return "trouble";
  if (now?.state === "done" && was?.state !== "done") return "done";
  return null;
}

/** Whether a sound may play at `now` after the last one at `last` (ms). */
export const allowed = (last: number | null, now: number) =>
  last === null || now - last >= ONE_PER_MS;

/** The octaves each note is made of, with how much of each: together they peak at 1. */
const PARTIALS = [
  [1, 0.85],
  [2, 0.15],
] as const;

function schedule(ctx: AudioContext, n: Note, t0: number) {
  const start = t0 + n.at;
  const top = start + n.attack;
  const fall = top + n.hold;
  const end = fall + n.release;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, start);
  env.gain.linearRampToValueAtTime(PEAK, top);
  env.gain.setValueAtTime(PEAK, fall);
  env.gain.linearRampToValueAtTime(0, end);
  env.connect(ctx.destination);
  for (const [times, mix] of PARTIALS) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(n.from * times, start);
    if (n.to !== n.from)
      osc.frequency.exponentialRampToValueAtTime(n.to * times, fall);
    const gain = ctx.createGain();
    gain.gain.value = mix;
    osc.connect(gain).connect(env);
    osc.start(start);
    osc.stop(end + 0.02);
  }
}

/** The dots the sounds last heard, and from where: whether Hearth's feed or the tray. */
export function hearing() {
  let before: readonly AgentDot[] | null = null;
  let from: boolean | null = null;
  return {
    /** The page was hidden: whatever changes meanwhile is no news. */
    forget() {
      before = null;
    },
    /** The sound `dots`, from the feed or not, call for: none for the first from a source. */
    hear(dots: readonly AgentDot[], feed: boolean): Cue | null {
      const was = feed === from ? before : null;
      before = dots;
      from = feed;
      return cueFor(was, dots);
    },
  };
}

/** How long `cue` sounds, in seconds, to the end of its last note's fade. */
export const tailOf = (cue: Cue) =>
  Math.max(...NOTES[cue].map((n) => n.at + n.attack + n.hold + n.release));

/** What the player needs of the page, so a test can stand in for it. */
export interface Speaker {
  make(): AudioContext | null;
  visible(): boolean;
  later(run: () => void, ms: number): number;
  cancel(id: number): void;
}

const page: Speaker = {
  make: () => {
    try {
      return new AudioContext();
    } catch {
      return null;
    }
  },
  visible: () => document.visibilityState === "visible",
  later: (run, ms) => window.setTimeout(run, ms),
  cancel: (id) => window.clearTimeout(id),
};

/** The dock's player: one audio context, made the first time it is needed. */
export function chime(on: Speaker = page) {
  let ctx: AudioContext | null = null;
  let last: number | null = null;
  /** Chromium has let the context run: after a press, or it never held it. */
  let woke = false;
  /** The context was suspended by the player itself, after a sound or a press. */
  let resting = false;
  let quiet: number | undefined;
  const context = (): AudioContext | null => (ctx ??= on.make());
  /** Suspends `c` once the sound just asked of it has faded, unless another comes first. */
  const hush = (c: AudioContext, seconds: number) => {
    if (quiet !== undefined) on.cancel(quiet);
    quiet = on.later(
      () => {
        quiet = undefined;
        resting = true;
        void c.suspend().catch(() => {});
      },
      (seconds + 0.1) * 1000,
    );
  };
  const sound = (c: AudioContext, cue: Cue) => {
    if (c.state !== "running") return;
    woke = true;
    const t0 = c.currentTime + 0.02;
    for (const n of NOTES[cue]) schedule(c, n, t0);
    hush(c, 0.02 + tailOf(cue));
  };
  return {
    /** A press on the dock: Chromium lets a pressed page start its audio. */
    unlock() {
      const c = context();
      if (!c || woke) return;
      const ran = () => {
        woke = c.state === "running";
        // Running, but with nothing to play: quiet again.
        if (woke && quiet === undefined) hush(c, 0);
      };
      if (c.state === "suspended") void c.resume().then(ran, () => {});
      else ran();
    },
    /** Plays `cue` unless the page is hidden, one played less than a second ago, or Chromium
     * still holds the page's audio, which would play it late along with any others. */
    play(cue: Cue, now = performance.now()): boolean {
      if (!on.visible() || !allowed(last, now)) return false;
      const c = context();
      if (!c || c.state === "closed") return false;
      const running = c.state === "running" && !resting;
      if (!running && !woke) return false;
      last = now;
      if (running) sound(c, cue);
      else
        void c.resume().then(
          () => {
            resting = false;
            sound(c, cue);
          },
          () => {},
        );
      return true;
    },
  };
}
