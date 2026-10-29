// What the agent dock does under the pointer (dockHover.ts): which dot the open notch's status
// label is about, what the label says, and when a press drags the tab. Run: bun src/nook/dockHover.test.ts
import assert from "node:assert/strict";
import type { AgentDot } from "@/bindings";
import { cardAction, DRAG_AFTER, drags, follow, labelText } from "./dockHover";

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

// Moving from a dot onto its label keeps the label on that dot, so its button can be reached:
// the notch is still open and the pointer is over no other dot.
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

// A press that wobbles a pixel or two is still a click; a few px more drags the tab.
const at = { x: 10, y: 100 };
assert.equal(drags(at, at), false);
assert.equal(drags(at, { x: 11, y: 102 }), false);
assert.equal(drags(at, { x: 10, y: 100 + DRAG_AFTER }), true);
assert.equal(drags(at, { x: 10, y: 100 - 30 }), true);

console.log("dockHover: all assertions passed");
