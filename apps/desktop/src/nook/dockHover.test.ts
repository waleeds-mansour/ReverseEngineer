// What the agent dock does under the pointer (dockHover.ts): which dot the open pill's status
// label is about, what the label says, how far the pointer may wander before the pill closes, and
// when a press drags the tab. Run: bun src/nook/dockHover.test.ts
import assert from "node:assert/strict";
import type { AgentDot } from "@/bindings";
import {
  cardAction,
  DRAG_AFTER,
  drags,
  follow,
  inboxCmd,
  labelText,
  nookClosed,
  REACH,
  stays,
} from "./dockHover";

const three = ["pip", "approvals", "worker"];

// The label is about the dot under the pointer, whichever it was about before.
assert.equal(follow(null, true, "pip", three), "pip");
assert.equal(follow("pip", true, "worker", three), "worker");

// Between dots, or over the label, it stays on its dot while that dot is there.
assert.equal(follow("approvals", true, null, three), "approvals");
assert.equal(follow(null, true, null, three), null);

// The dots changed under a pointer that stayed still: the dot under it now wins, and a dot
// that went takes the label with it.
assert.equal(
  follow("pip", true, "approvals", ["approvals", "pip"]),
  "approvals",
);
assert.equal(follow("worker", true, null, ["pip"]), null);
assert.equal(follow("pip", true, "gone", ["pip"]), null);

// Once the pointer has left, it is about nothing.
assert.equal(follow("pip", false, "pip", three), null);

// Nook closed the pill itself (the pointer left the window, the dock hid) or wouldn't open it.
assert.equal(nookClosed(true, false, false), true);
// A view sent before Nook took the page's ask says nothing about it.
assert.equal(nookClosed(true, false, true), false);
assert.equal(nookClosed(true, true, false), false);
assert.equal(nookClosed(false, false, false), false);

// Moving from a dot onto its label keeps the label on that dot, so its button can be reached:
// the pointer is still in the pill's reach and over no other dot.
assert.equal(follow("pip", true, "pip", three), "pip");
assert.equal(follow("pip", true, null, three), "pip");

// Each label's button opens the page where its agent is, and nothing that acts.
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

// The Inbox button opens what waits, on Today for now.
assert.deepEqual(inboxCmd(), { kind: "open_today" });

// The label says the dot's state, then its last line, unless that only says the state again.
const dot = (d: Partial<AgentDot>): AgentDot => ({
  id: "pip",
  label: "Pip",
  kind: "pip",
  state: "working",
  line: "Thinking about your brief",
  waiting: 0,
  ...d,
});
assert.deepEqual(labelText(dot({})), {
  head: "Working",
  tail: "Thinking about your brief",
});
assert.deepEqual(labelText(dot({ state: "needs_you", line: "Needs you" })), {
  head: "Needs you",
  tail: "",
});
assert.deepEqual(labelText(dot({ state: "done", line: "Answered" })), {
  head: "Done",
  tail: "Answered",
});
// A dot at rest says only its line, and a service which it is, since its amber says the rest.
assert.deepEqual(labelText(dot({ state: "idle", line: "Resting" })), {
  head: "Resting",
  tail: "",
});
assert.deepEqual(
  labelText(
    dot({
      kind: "service",
      label: "Nook's server",
      state: "needs_you",
      line: "Not answering",
    }),
  ),
  { head: "Nook's server", tail: "Not answering" },
);

// The pill stays open while the pointer is near the column or over the label, and closes once it
// has wandered further.
const column = { left: 322, top: 100, right: 356, bottom: 300 };
const label = { left: 60, top: 140, right: 310, bottom: 172 };
assert.equal(stays({ x: 340, y: 200 }, column, null), true);
assert.equal(stays({ x: 322 - REACH, y: 200 }, column, null), true);
assert.equal(stays({ x: 322 - REACH - 1, y: 200 }, column, null), false);
assert.equal(stays({ x: 340, y: 300 + REACH }, column, null), false);
assert.equal(stays({ x: 100, y: 150 }, column, label), true);
assert.equal(stays({ x: 100, y: 150 }, column, null), false);
assert.equal(stays({ x: 100, y: 180 }, column, label), false);

// A press that wobbles a pixel or two is still a click; a few px more drags the tab.
const at = { x: 10, y: 100 };
assert.equal(drags(at, at), false);
assert.equal(drags(at, { x: 11, y: 102 }), false);
assert.equal(drags(at, { x: 10, y: 100 + DRAG_AFTER }), true);
assert.equal(drags(at, { x: 10, y: 100 - 30 }), true);

console.log("dockHover: all assertions passed");
