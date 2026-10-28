// The agent dock's sizes and the edge tab's outline (dockShape.ts), which must match the window
// docksize.rs makes for the page. Run: bun src/nook/dockShape.test.ts
import assert from "node:assert/strict";
import { pillLong, TAB, tabLong, tabPath, windowSize } from "./dockShape";

// Two 22 px flares around a body of 25 px and a 13 px slot per dot, 9 px apart: 104 for two.
assert.equal(tabLong(1), 82);
assert.equal(tabLong(2), 104);
assert.equal(tabLong(3), 126);
// No dots still draws a tab for one, as Nook sizes the window for one.
assert.equal(tabLong(0), tabLong(1));

// Two round buttons, the agents' capsule and the tools' capsule, 8 px apart.
assert.equal(pillLong(1), 196);
assert.equal(pillLong(2), 216);

// The window at rest is the tab and room for its shadow and badge; open, room for the pill and a
// label beside it. The same numbers as dock_tests.rs.
assert.deepEqual(windowSize(1, false), [39, 122]);
assert.deepEqual(windowSize(2, false), [39, 144]);
assert.deepEqual(windowSize(1, true), [384, 256]);
assert.deepEqual(windowSize(4, true), [384, 316]);

// The outline leaves the screen's edge along it, reaches the body, runs down it and goes back.
const right = tabPath(104, "right");
assert.equal(
  right,
  "M25 0 C25 18.7 0 3.3 0 22 L0 82 C0 100.7 25 85.3 25 104 Z",
);
// The left edge's is its mirror image, leaving x = 0.
const left = tabPath(104, "left");
assert.equal(left, "M0 0 C0 18.7 25 3.3 25 22 L25 82 C25 100.7 0 85.3 0 104 Z");
// Each flare meets the edge and the body going straight along them: the handles share the x of
// the end they leave from.
for (const path of [right, left]) {
  const nums = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  assert.equal(nums[0], nums[2]);
  assert.equal(nums[4], nums[6]);
}
assert.equal(TAB.deep, 25);

console.log("dockShape: all assertions passed");
