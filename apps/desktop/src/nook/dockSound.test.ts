// The agent dock's sounds (dockSound.ts): how loud they get, how they swell and fade, which change
// calls for which, how often they may play, and that a sound asked while Chromium holds the page's
// audio is dropped rather than kept to burst out later. Run: bun src/nook/dockSound.test.ts
import assert from "node:assert/strict";
import type { AgentDot } from "@/bindings";
import {
  allowed,
  chime,
  type Cue,
  cueFor,
  hearing,
  level,
  NOTES,
  ONE_PER_MS,
  PEAK,
  tailOf,
} from "./dockSound";

// -18 dBFS.
assert.ok(Math.abs(20 * Math.log10(PEAK) + 18) < 1e-9);

// No sound ever passes the peak, the cue's two notes together included, and each starts and ends
// in silence, swelling in and fading out over about 150 ms so none clicks.
for (const cue of Object.keys(NOTES) as Cue[]) {
  const notes = NOTES[cue];
  let top = 0;
  for (let t = 0; t <= 1; t += 0.001) top = Math.max(top, level(notes, t));
  assert.ok(top <= PEAK + 1e-12, `${cue} peaks at ${top}`);
  assert.ok(top >= PEAK * 0.99, `${cue} reaches the peak`);
  assert.equal(level(notes, 0), 0);
  assert.equal(level(notes, 1), 0);
  for (const n of notes) {
    assert.equal(n.attack, 0.15);
    assert.ok(n.release >= 0.15 && n.release <= 0.22);
  }
}
// The cue is two notes, rising; trouble one low note; done one note gliding up.
assert.equal(NOTES.asks.length, 2);
assert.ok(NOTES.asks[1].from > NOTES.asks[0].from);
assert.ok(NOTES.trouble[0].from < 300);
assert.ok(NOTES.done[0].to > NOTES.done[0].from);

const dot = (d: Partial<AgentDot>): AgentDot => ({
  id: "pip",
  label: "Pip",
  kind: "pip",
  state: "idle",
  line: "Resting",
  waiting: 0,
  ...d,
});
const pip = dot({});

// Nothing on the first draw, or when nothing changed.
assert.equal(cueFor(null, [dot({ waiting: 3, state: "needs_you" })]), null);
assert.equal(cueFor([pip], [pip]), null);

// Something new waits: an approval, or something Pip asks.
const yes = (n: number) =>
  dot({ id: "approvals", kind: "approvals", state: "needs_you", waiting: n });
assert.equal(cueFor([pip], [pip, yes(1)]), "asks");
assert.equal(cueFor([pip, yes(1)], [pip, yes(2)]), "asks");
assert.equal(cueFor([pip], [dot({ state: "needs_you", waiting: 1 })]), "asks");
// Less waiting is no news.
assert.equal(cueFor([pip, yes(2)], [pip, yes(1)]), null);

// A service in trouble, or Pip not answering.
const server = dot({ id: "server", kind: "service", state: "needs_you" });
assert.equal(cueFor([pip], [pip, server]), "trouble");
assert.equal(cueFor([pip, server], [pip, server]), null);
assert.equal(cueFor([pip], [dot({ state: "needs_you" })]), "trouble");

// Pip finished something.
assert.equal(
  cueFor([dot({ state: "working" })], [dot({ state: "done" })]),
  "done",
);
assert.equal(
  cueFor([dot({ state: "done" })], [dot({ state: "done", line: "Sent" })]),
  null,
);

// At most one a second.
assert.equal(allowed(null, 5), true);
assert.equal(allowed(1000, 1000 + ONE_PER_MS - 1), false);
assert.equal(allowed(1000, 1000 + ONE_PER_MS), true);

// The feed coming back is no news: its counts start over, as do the first after the page was
// hidden.
const ears = hearing();
assert.equal(ears.hear([pip], false), null);
assert.equal(ears.hear([pip, yes(1)], false), "asks");
assert.equal(ears.hear([pip, yes(3)], true), null, "the feed came back");
assert.equal(ears.hear([pip, yes(4)], true), "asks");
assert.equal(ears.hear([pip, yes(4)], false), null, "the feed went away");
ears.forget();
assert.equal(ears.hear([pip, yes(5)], false), null);

// The player, with a stand-in for Chromium's audio: held until the dock is pressed.
class Held {
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  pressed = false;
  started = 0;
  resume() {
    if (!this.pressed) return new Promise<void>(() => {});
    this.state = "running";
    return Promise.resolve();
  }
  suspend() {
    this.state = "suspended";
    return Promise.resolve();
  }
  createGain() {
    const param = {
      value: 0,
      setValueAtTime() {},
      linearRampToValueAtTime() {},
    };
    return { gain: param, connect: <T>(to: T) => to };
  }
  createOscillator() {
    const frequency = {
      setValueAtTime() {},
      exponentialRampToValueAtTime() {},
    };
    const start = () => void (this.started += 1);
    return { type: "", frequency, connect: <T>(to: T) => to, start, stop() {} };
  }
}
const audio = new Held();
let visible = true;
const timers: { run: () => void; ms: number }[] = [];
const player = chime({
  make: () => audio as unknown as AudioContext,
  visible: () => visible,
  later: (run, ms) => timers.push({ run, ms }) - 1,
  cancel: (id) => void (timers[id].run = () => {}),
});
const settle = () => new Promise((done) => setTimeout(done, 0));
const fire = () => timers.splice(0).forEach((t) => t.run());

// Before any press, a sound is dropped, and a press later doesn't play it.
assert.equal(player.play("asks", 0), false);
audio.pressed = true;
player.unlock();
await settle();
assert.equal(audio.state, "running");
assert.equal(audio.started, 0, "nothing was kept to play");
// Running with nothing to play, it is suspended again.
fire();
assert.equal(audio.state, "suspended");
// Pressed once, a sound wakes it, plays, and it is suspended once the last note has faded.
assert.equal(player.play("done", 5000), true);
await settle();
assert.equal(audio.started, 2, "one note, two octaves");
assert.equal(audio.state, "running");
assert.equal(
  timers[timers.length - 1]?.ms,
  (0.02 + tailOf("done") + 0.1) * 1000,
);
fire();
assert.equal(audio.state, "suspended");
// Hidden, nothing.
visible = false;
assert.equal(player.play("trouble", 9000), false);
assert.equal(tailOf("asks"), 0.17 + 0.15 + 0.06 + 0.18);

console.log("dockSound: all assertions passed");
