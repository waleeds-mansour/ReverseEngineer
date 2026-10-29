// What keys do in the quick-ask box (askKeys.ts). Run: bun src/nook/askKeys.test.ts
import assert from "node:assert/strict";
import type { AskMic, AskPhase } from "@/bindings";
import { editable, keyCmd, typable } from "./askKeys";
import { askCopy, hintFor } from "./askParts";

const at = (
  phase: AskPhase,
  text = "",
  mic: AskMic = "ready",
  thread = false,
) => ({ phase, text, mic, thread });

// Enter sends what is typed, as it is; an empty box sends nothing.
assert.deepEqual(keyCmd("Enter", at("typing", " Remind me at 5 ")), {
  kind: "send",
  text: " Remind me at 5 ",
});
assert.equal(keyCmd("Enter", at("typing", "   ")), null);
assert.equal(keyCmd("Enter", at("failed")), null);
assert.deepEqual(keyCmd("Enter", at("failed", "Book the room")), {
  kind: "send",
  text: "Book the room",
});

// While a send waits or goes, Enter does nothing, and Esc undoes only one that waits.
assert.equal(keyCmd("Enter", at("waiting", "x")), null);
assert.equal(keyCmd("Enter", at("sending", "x")), null);
assert.deepEqual(keyCmd("Escape", at("waiting")), { kind: "undo" });
assert.deepEqual(keyCmd("Escape", at("sending")), { kind: "close" });

// After Pip's answer, Enter on the empty box opens the conversation; typed, it sends anew.
assert.deepEqual(keyCmd("Enter", at("sent")), { kind: "open_conversation" });
assert.deepEqual(keyCmd("Enter", at("sent", "And tomorrow?")), {
  kind: "send",
  text: "And tomorrow?",
});

// Esc otherwise closes the box; other keys, Space among them, are the box's own.
assert.deepEqual(keyCmd("Escape", at("typing", "half typed")), {
  kind: "close",
});
assert.equal(keyCmd("a", at("typing")), null);
assert.equal(keyCmd(" ", at("typing", "two words")), null);

// Listening after a click: Space or Enter keeps what was said, Esc throws it away.
const listening = at("typing", "", "listening");
const keep = { kind: "stop_listening", keep: true };
assert.deepEqual(keyCmd(" ", listening), keep);
assert.deepEqual(keyCmd("Enter", { ...listening, text: "typed first" }), keep);
assert.deepEqual(keyCmd("Escape", listening), {
  kind: "stop_listening",
  keep: false,
});
// Held by Ctrl, letting go stops it: Space and Enter do nothing, Esc still throws it away.
const held = at("typing", "", "held");
assert.equal(keyCmd(" ", held), null);
assert.equal(keyCmd("Enter", held), null);
assert.deepEqual(keyCmd("Escape", held), {
  kind: "stop_listening",
  keep: false,
});
// While what was said is written down, Enter waits for it.
assert.equal(keyCmd("Enter", at("typing", "x", "hearing")), null);

// Tab starts a new conversation, or continues again, only when there is one to continue.
assert.deepEqual(keyCmd("Tab", at("typing", "", "ready", true)), {
  kind: "fresh",
});
assert.deepEqual(keyCmd("Tab", at("sent", "", "ready", true)), {
  kind: "fresh",
});
assert.equal(keyCmd("Tab", at("typing")), null);
assert.equal(keyCmd("Tab", at("waiting", "", "ready", true)), null);

assert.ok(editable("typing") && editable("sent") && editable("failed"));
assert.ok(!editable("waiting") && !editable("sending"));
assert.ok(typable("typing", "ready") && typable("sent", "busy"));
assert.ok(!typable("typing", "listening") && !typable("typing", "hearing"));
assert.ok(!typable("waiting", "ready"));

// The line below the pill names the keys for what the box is doing.
const hint = (phase: AskPhase, mic: AskMic = "ready", continuing = false) =>
  hintFor({ phase, mic, continuing: continuing ? "Plan the offsite" : null });
assert.equal(hint("typing"), askCopy.hint);
assert.equal(hint("typing", "listening"), askCopy.hintListening);
assert.equal(hint("typing", "held"), askCopy.hintHeld);
assert.equal(hint("typing", "hearing"), "");
assert.equal(hint("waiting"), askCopy.hintWaiting);
assert.equal(hint("sending"), "");
assert.equal(hint("sent"), askCopy.open);
assert.equal(
  hint("sent", "ready", true),
  "",
  "where a follow-up goes says more",
);

console.log("askKeys: ok");
