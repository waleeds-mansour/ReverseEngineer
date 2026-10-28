// How the quick-ask box adds what its mic heard (askType.ts). Run: bun src/nook/askType.test.ts
import assert from "node:assert/strict";
import { joined } from "./askType";

// An empty box takes the words as they are; typed text gets a space before them, once.
assert.equal(joined("", "Remind me at five"), "Remind me at five");
assert.equal(joined("Ask Sam", "about Friday"), "Ask Sam about Friday");
assert.equal(joined("Ask Sam ", "about Friday"), "Ask Sam about Friday");
assert.equal(joined("Line one\n", "two"), "Line one\ntwo");

// Never past the box's limit, counted in characters, not halves of one.
assert.equal(joined("abc", "def", 5), "abc d");
assert.equal(joined("", "😀😀😀", 2), "😀😀");

console.log("askType: ok");
