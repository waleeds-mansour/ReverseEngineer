// The agent dock's sizes (dockShape.ts), which must match docksize.rs. Run: bun
// src/nook/dockShape.test.ts
import assert from "node:assert/strict";
import {
  NOTCH,
  notchBody,
  notchLong,
  TAB,
  tabBody,
  tabLong,
} from "./dockShape";

// Two 22 px flares around a body of 25 px and a 13 px slot per dot, 9 px apart: 104 for two.
assert.equal(tabLong(1), 82);
assert.equal(tabLong(2), 104);
assert.equal(tabLong(3), 126);
assert.equal(tabBody(1), 38);
// No dots still draws a tab for one, as Nook keeps the region for one.
assert.equal(tabLong(0), tabLong(1));
assert.equal(TAB.deep, 25);

// Open: the Inbox, Pip's mark, the mic and "…" at 44 px, a dot every 28 px, between 36 px flares.
assert.equal(notchBody(1), 224);
assert.equal(notchBody(3), 280);
assert.equal(notchLong(1), 296);
assert.equal(notchLong(0), notchLong(1));
// docksize.rs's NOTCH_DEEP, and a 40 px circle fits the column with room to spare.
assert.equal(NOTCH.deep, 52);
assert.ok(NOTCH.hit <= NOTCH.deep - 8);
assert.ok(NOTCH.hit <= NOTCH.button);

console.log("dockShape: all assertions passed");
