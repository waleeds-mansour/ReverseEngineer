// What the notch's chat makes of Pip's words before drawing them (chatText.ts): light markdown,
// links shown with where they go, how long ago a conversation moved, and what a key does.
// Run: bun src/nook/chatText.test.ts
import assert from "node:assert/strict";
import { ago, atBottom, blocks, chatKey, INLINE_MAX, inline } from "./chatText";

// Inline: code, bold and links; the rest is text as it was.
assert.deepEqual(inline("Run `pnpm check` **now**"), [
  { kind: "text", text: "Run " },
  { kind: "code", text: "pnpm check" },
  { kind: "text", text: " " },
  { kind: "bold", text: "now" },
]);
assert.deepEqual(inline("plain"), [{ kind: "text", text: "plain" }]);
assert.deepEqual(inline(""), []);

// A link's words can say anything, so where it goes is shown beside them; a bare address is
// itself, and the full stop after it isn't part of it.
assert.deepEqual(inline("See [your bank](https://evil.example/login)"), [
  { kind: "text", text: "See " },
  {
    kind: "link",
    text: "your bank",
    url: "https://evil.example/login",
    host: "evil.example",
  },
]);
assert.deepEqual(inline("At https://nook.local/today."), [
  { kind: "text", text: "At " },
  {
    kind: "link",
    text: "https://nook.local/today",
    url: "https://nook.local/today",
    host: null,
  },
  { kind: "text", text: "." },
]);
// Only web addresses become links: nothing else is shown as one.
assert.deepEqual(inline("[run](javascript:alert(1))"), [
  { kind: "text", text: "[run](javascript:alert(1))" },
]);

// Blocks: paragraphs split on blank lines and keep their lines; lists, headings and code.
const text = [
  "# Your week",
  "Three things stand out.",
  "Mostly calm.",
  "",
  "- Dentist on **Thursday**",
  "- Call Sam",
  "1. First",
  "2) Second",
  "```",
  "pnpm check",
  "```",
  "Done.",
].join("\n");
const b = blocks(text);
assert.deepEqual(
  b.map((x) => x.kind),
  ["head", "para", "list", "list", "code", "para"],
);
assert.equal(b[1]?.kind === "para" && b[1].lines.length, 2);
assert.equal(b[2]?.kind === "list" && !b[2].ordered && b[2].items.length, 2);
assert.equal(b[3]?.kind === "list" && b[3].ordered && b[3].items.length, 2);
assert.deepEqual(b[4], { kind: "code", text: "pnpm check" });
// An unclosed fence runs to the end; Windows line ends are lines too.
assert.deepEqual(blocks("```\na\r\nb"), [{ kind: "code", text: "a\nb" }]);
assert.deepEqual(blocks("  \n\n"), []);

// How long ago, shortly.
const now = Date.parse("2026-10-29T12:00:00.000Z");
assert.equal(ago("2026-10-29T11:59:30.000Z", now), "now");
assert.equal(ago("2026-10-29T11:55:00.000Z", now), "5m");
assert.equal(ago("2026-10-29T09:00:00.000Z", now), "3h");
assert.equal(ago("2026-10-27T12:00:00.000Z", now), "2d");
assert.equal(ago("", now), "");
assert.equal(ago("soon", now), "");

// Keys: Enter sends, Shift+Enter is the box's new line, Esc is the switcher's while it's open
// and otherwise the notch's; nothing while an input method is composing.
const key = (k: string, shiftKey = false, isComposing = false) => ({
  key: k,
  shiftKey,
  isComposing,
});
assert.equal(chatKey(key("Enter"), false), "send");
assert.equal(chatKey(key("Enter", true), false), null);
assert.equal(chatKey(key("Enter", false, true), false), null);
assert.equal(chatKey(key("Escape"), false), null);
assert.equal(chatKey(key("Escape"), true), "close_menu");
assert.equal(chatKey(key("ArrowDown"), true), "menu_down");
assert.equal(chatKey(key("ArrowUp"), true), "menu_up");
assert.equal(chatKey(key("Enter"), true), "pick");
assert.equal(chatKey(key("a"), true), null);

// At the newest line, give or take a little.
assert.equal(atBottom(570, 1000, 400), true);
assert.equal(atBottom(500, 1000, 400), false);

// The scan stays quick however a line piles up brackets, backticks or addresses with nothing to
// close them, and past INLINE_MAX a line is shown as it is.
for (const piled of [
  "[a".repeat(10_000),
  "`a".repeat(10_000),
  "**a".repeat(7_000),
  "http://".repeat(3_000),
  "[a](http://".repeat(2_000),
]) {
  const started = performance.now();
  const spans = inline(piled);
  const took = performance.now() - started;
  assert.ok(took < 250, `${piled.slice(0, 12)}… took ${took.toFixed(0)} ms`);
  assert.equal(spans.map((s) => s.text).join("").length > 0, true);
}
const long = `${"x".repeat(INLINE_MAX)} \`code\``;
assert.deepEqual(inline(long), [{ kind: "text", text: long }]);

console.log("chatText: all assertions passed");
