// Which dot the agent dock's card is about (dockHover.ts). Run: bun src/nook/dockHover.test.ts
import assert from "node:assert/strict";
import { cardAction, DRAG_AFTER, drags, follow, nookClosed } from "./dockHover";

const three = ["pip", "approvals", "worker"];

// The card is about the dot under the pointer, whichever it was about before.
assert.equal(follow(null, true, "pip", three), "pip");
assert.equal(follow("pip", true, "worker", three), "worker");

// Between dots, over the card or in its room, it stays on its dot while that dot is there.
assert.equal(follow("approvals", true, null, three), "approvals");
assert.equal(follow(null, true, null, three), null);

// The dots changed under a pointer that stayed still: the dot under it now wins, and a dot
// that went takes the card with it.
assert.equal(
  follow("pip", true, "approvals", ["approvals", "pip"]),
  "approvals",
);
assert.equal(follow("worker", true, null, ["pip"]), null);
assert.equal(follow("pip", true, "gone", ["pip"]), null);

// Once the pointer has left, it is about nothing.
assert.equal(follow("pip", false, "pip", three), null);

// Nook closed the card itself (the pointer left the window, the dock hid) or wouldn't open it.
assert.equal(nookClosed(true, false, false), true);
// A view sent before Nook took the page's ask says nothing about it.
assert.equal(nookClosed(true, false, true), false);
assert.equal(nookClosed(true, true, false), false);
assert.equal(nookClosed(false, false, false), false);

// Moving from a dot into its card keeps the card on that dot, so its button can be reached: the
// pointer is still in the window and over no other dot.
assert.equal(follow("pip", true, "pip", three), "pip");
assert.equal(follow("pip", true, null, three), "pip");

// Each card's button opens the page where its agent is, and nothing that acts.
assert.deepEqual(cardAction("pip"), {
  label: "Open conversation",
  page: "conversation",
});
assert.deepEqual(cardAction("approvals"), {
  label: "Review",
  page: "approvals",
});
assert.deepEqual(cardAction("service"), {
  label: "Open status",
  page: "status",
});

// A press that wobbles a pixel or two is still a click; a few px more drags the strip.
const at = { x: 10, y: 100 };
assert.equal(drags(at, at), false);
assert.equal(drags(at, { x: 11, y: 102 }), false);
assert.equal(drags(at, { x: 10, y: 100 + DRAG_AFTER }), true);
assert.equal(drags(at, { x: 10, y: 100 - 30 }), true);

console.log("dockHover: all assertions passed");
