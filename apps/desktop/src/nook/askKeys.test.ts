// What Enter and Esc do in the quick-ask box (askKeys.ts). Run: bun src/nook/askKeys.test.ts
import assert from "node:assert/strict";
import { editable, keyCmd } from "./askKeys";

// Enter sends what is typed, as it is; an empty box sends nothing.
assert.deepEqual(keyCmd("Enter", "typing", " Remind me at 5 "), {
  kind: "send",
  text: " Remind me at 5 ",
});
assert.equal(keyCmd("Enter", "typing", "   "), null);
assert.equal(keyCmd("Enter", "failed", ""), null);
assert.deepEqual(keyCmd("Enter", "failed", "Book the room"), {
  kind: "send",
  text: "Book the room",
});

// While a send waits or goes, Enter does nothing, and Esc undoes only one that waits.
assert.equal(keyCmd("Enter", "waiting", "x"), null);
assert.equal(keyCmd("Enter", "sending", "x"), null);
assert.deepEqual(keyCmd("Escape", "waiting", ""), { kind: "undo" });
assert.deepEqual(keyCmd("Escape", "sending", ""), { kind: "close" });

// After Pip's answer, Enter on the empty box opens the conversation; typed, it sends anew.
assert.deepEqual(keyCmd("Enter", "sent", ""), { kind: "open_conversation" });
assert.deepEqual(keyCmd("Enter", "sent", "And tomorrow?"), {
  kind: "send",
  text: "And tomorrow?",
});

// Esc otherwise closes the box; other keys are the box's own.
assert.deepEqual(keyCmd("Escape", "typing", "half typed"), { kind: "close" });
assert.equal(keyCmd("a", "typing", ""), null);

assert.ok(editable("typing") && editable("sent") && editable("failed"));
assert.ok(!editable("waiting") && !editable("sending"));

console.log("askKeys: ok");
