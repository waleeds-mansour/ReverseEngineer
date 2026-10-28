// What the agent dock's page tells Nook about its status label (dockLabel.ts): the whole glide
// between two dots, then just where it settled, and that it is gone once it has faded out; and
// nothing again for the same aim. Run: bun src/nook/dockLabel.test.ts
import assert from "node:assert/strict";
import type { UiCmd } from "@/bindings";
import { labelCmd, labelReporter, union } from "./dockLabel";

const sent: UiCmd[] = [];
let timers: { run: () => void; ms: number; off: boolean }[] = [];
const report = labelReporter(
  (cmd) => sent.push(cmd),
  () => 360,
  {
    later: (run, ms) => timers.push({ run, ms, off: false }) - 1,
    cancel: (id) => void (timers[id].off = true),
  },
);
const settle = () => {
  const now = timers;
  timers = [];
  for (const t of now) if (!t.off) t.run();
};
const last = () => sent[sent.length - 1];
const label = (top: number, bottom: number, wide: number): UiCmd => ({
  kind: "dock_label",
  top,
  bottom,
  wide,
});

// Whole px that cover it, and 0 wide for none.
assert.deepEqual(
  labelCmd({ top: 99.5, bottom: 131.2, wide: 180.4 }),
  label(99, 132, 181),
);
assert.deepEqual(labelCmd(null), label(0, 0, 0));
assert.deepEqual(union(null, { top: 1, bottom: 2, wide: 3 }), {
  top: 1,
  bottom: 2,
  wide: 3,
});

// It shows beside a dot: Nook hears at once, and nothing more once it has settled.
report({ top: 100, bottom: 132, wide: 180 });
assert.deepEqual(sent, [label(100, 132, 180)]);
assert.equal(timers[0].ms, 360);
settle();
assert.equal(sent.length, 1);

// The page draws it again on every move of the pointer: the same aim sends and restarts nothing.
report({ top: 100, bottom: 132, wide: 180 });
assert.equal(sent.length, 1);
assert.equal(timers.length, 0);

// To another dot, with longer words: both places and all between while it glides...
report({ top: 140, bottom: 172, wide: 240 });
assert.deepEqual(last(), label(100, 172, 240));
// ...and on again before it settled: still from where it was.
report({ top: 180, bottom: 212, wide: 120 });
assert.deepEqual(last(), label(100, 212, 240));
settle();
assert.deepEqual(last(), label(180, 212, 120), "where it settled");

// It fades out where it is, and only then is it gone.
const before = sent.length;
report(null);
assert.equal(sent.length, before);
settle();
assert.deepEqual(last(), label(0, 0, 0));
// Back before a fade is over: Nook still has it, so nothing to say.
report({ top: 180, bottom: 212, wide: 120 });
const shown = sent.length;
report(null);
report({ top: 180, bottom: 212, wide: 120 });
assert.equal(sent.length, shown);
settle();
assert.equal(sent.length, shown);

console.log("dockLabel: all assertions passed");
