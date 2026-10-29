// The Inbox's keyboard and clock (inboxFlow.ts): every answer waits two seconds for Esc, then goes
// once and "Sent" shows before the next card; E clears only what doesn't wait on you; J and K
// move between cards; a refusal brings the card back with Hearth's words; a new list keeps the
// card you're on. Run: bun src/nook/inboxFlow.test.ts
import assert from "node:assert/strict";
import {
  begin,
  behind,
  current,
  dotsOf,
  filled,
  noteOf,
  openAt,
  press,
  recommendedOf,
  refresh,
  refused,
  rowsOf,
  SETTLE_MS,
  takeBack,
  SENT_MS,
  tick,
  typed,
  WAIT_MS,
} from "./inboxFlow";
import type { InboxCard } from "./inboxTypes";

const card = (id: string, more: Partial<InboxCard> = {}): InboxCard => ({
  id,
  kind: "finished",
  title: `Card ${id}`,
  line: "",
  at: "2026-10-28T09:00:00.000Z",
  url: "/inbox",
  outside: false,
  seen: false,
  approval_id: null,
  risk: null,
  question_id: null,
  choices: [],
  replies: [],
  recommended: null,
  ...more,
});

const question = card("q", {
  kind: "question",
  question_id: "q1",
  choices: ["The small room", "The big room", "Either"],
});
const ask = card("a", {
  kind: "approval",
  approval_id: "ap1",
  risk: "self_external",
});
const done = card("f", { replies: ["Send it", "Make it shorter"] });
const brief = card("b", { kind: "brief", url: "/today" });

// Each card's rows, and that the desk never offers Always allow.
assert.deepEqual(
  rowsOf(question).map((r) => r.act),
  [0, 1, 2].map((choice) => ({
    kind: "answer",
    question_id: "q1",
    choice,
    text: null,
  })),
);
assert.deepEqual(
  rowsOf(ask).map((r) => [r.label, r.act]),
  [
    ["Yes", { kind: "decide", approval_id: "ap1", yes: true }],
    ["No", { kind: "decide", approval_id: "ap1", yes: false }],
  ],
);
assert.deepEqual(
  rowsOf(done).map((r) => r.act),
  [
    { kind: "reply", id: "f", choice: 0 },
    { kind: "reply", id: "f", choice: 1 },
  ],
);
assert.deepEqual(rowsOf(brief), []);

// 2 waits, Esc takes it back, nothing has gone.
let f = begin([question, ask, done, brief], 0);
assert.deepEqual(noteOf(f).bits, [
  "Press ",
  { key: "1" },
  ", ",
  { key: "2" },
  " or ",
  { key: "3" },
  " to answer",
]);
let s = press(f, "2", 100);
assert.equal(s.flow.phase, "wait");
assert.deepEqual(s.out, []);
assert.equal(filled(s.flow, 100 + WAIT_MS / 2), 0.5);
assert.deepEqual(tick(s.flow, 100 + WAIT_MS - 1).out, []);
s = press(s.flow, "Escape", 1500);
assert.equal(s.flow.phase, "ask");
assert.equal(s.close, undefined);
assert.equal(tick(s.flow, 9000).out.length, 0);

// Picked again and left alone, it goes once after two seconds; "Sent", then the next card.
s = press(s.flow, "3", 2000);
s = tick(s.flow, 2000 + WAIT_MS);
assert.deepEqual(s.out, [
  { kind: "answer", question_id: "q1", choice: 2, text: null },
]);
assert.equal(s.flow.phase, "sent");
assert.deepEqual(noteOf(s.flow), { bits: ["Sent to Pip"], tone: "sent" });
assert.deepEqual(press(s.flow, "1", 4100).out, []);
assert.deepEqual(tick(s.flow, 4100).out, []);
s = tick(s.flow, 2000 + WAIT_MS + SENT_MS);
assert.equal(current(s.flow)?.id, "a");
assert.equal(s.flow.phase, "ask");
assert.equal(s.flow.cards.length, 3);

// E on what waits for a yes says to answer it; J moves on (and marks the next seen); K back.
f = s.flow;
assert.equal(press(f, "e", 6000).flow.said, "answer");
assert.deepEqual(noteOf(press(f, "e", 6000).flow).bits, [
  "Answer this one first",
]);
s = press(f, "j", 6000);
assert.equal(current(s.flow)?.id, "f");
assert.deepEqual(s.out, [{ kind: "seen", id: "f" }]);
assert.deepEqual(noteOf(s.flow).bits, [
  "Press ",
  { key: "1" },
  " or ",
  { key: "2" },
  " to reply",
]);
assert.equal(current(press(s.flow, "k", 6100).flow)?.id, "a");
assert.equal(
  current(press(press(s.flow, "j", 6100).flow, "j", 6200).flow)?.id,
  "b",
);

// E clears finished work, after the same wait.
s = press(s.flow, "e", 7000);
s = tick(s.flow, 7000 + WAIT_MS);
assert.deepEqual(s.out, [{ kind: "clear", id: "f" }]);
assert.deepEqual(noteOf(s.flow).bits, ["Cleared"]);

// O opens the card in Hearth's window and closes the Inbox; Esc with nothing waiting closes it.
const o = press(begin([brief], 0), "o", 0);
assert.deepEqual([o.out, o.close], [[{ kind: "show", url: "/today" }], true]);
assert.deepEqual(press(begin([brief], 0), "Escape", 0).out, [
  { kind: "close" },
]);
assert.deepEqual(noteOf(begin([brief], 0)).bits, [
  "Press ",
  { key: "E" },
  " to clear, ",
  { key: "O" },
  " to open",
]);

// Words of your own answer an open question, and only that.
s = typed(begin([question], 0), "  Whichever is free  ", 0);
s = tick(s.flow, WAIT_MS);
assert.deepEqual(s.out, [
  {
    kind: "answer",
    question_id: "q1",
    choice: null,
    text: "Whichever is free",
  },
]);
assert.equal(typed(begin([done], 0), "hi", 0).flow.phase, "ask");
assert.equal(typed(begin([question], 0), "   ", 0).flow.phase, "ask");

// Hearth said no: the card is back, saying why.
s = tick(press(begin([done], 0), "1", 0).flow, WAIT_MS);
const back = refused(
  s.flow,
  "Those replies aren't offered any more.",
  WAIT_MS + 10,
);
assert.equal(back.phase, "ask");
assert.equal(current(back)?.id, "f");
assert.deepEqual(noteOf(back), {
  bits: ["Those replies aren't offered any more."],
  tone: "warn",
});

// A new list keeps the card you're on, and the one whose answer waits even if it's gone.
f = press(begin([question, ask, done], 0), "j", 0).flow;
f = refresh(f, [card("new"), question, ask, done], 0);
assert.equal(current(f)?.id, "a");
s = press(f, "1", 0);
f = refresh(s.flow, [card("new"), question, done], 0);
assert.equal(current(f)?.id, "a");
assert.equal(f.phase, "wait");

// The header's dots and the stack behind.
f = press(begin([question, ask, done, brief], 0), "j", 0).flow;
assert.deepEqual(dotsOf(f), ["seen", "current", "upcoming", "upcoming"]);
assert.equal(behind(f), 2);
assert.equal(behind(begin([brief], 0)), 0);
const many = begin(
  Array.from({ length: 12 }, (_, i) => card(`c${i}`)),
  0,
);
assert.equal(dotsOf(many).length, 7);
assert.deepEqual(noteOf(begin([], 0)), { bits: ["All clear"], tone: "clear" });

// Opened at a notice's card: it comes to the front and counts as shown, unless an answer waits
// on the card in front, or the list doesn't have it yet.
f = openAt(begin([question, ask, done], 0), "f");
assert.equal(current(f)?.id, "f");
assert.equal(f.dir, 1);
assert.deepEqual(f.shown, ["q", "f"]);
assert.equal(current(openAt(f, "q"))?.id, "q");
assert.equal(openAt(f, "q").dir, -1);
assert.equal(openAt(f, "gone"), f);
s = press(begin([question, ask], 0), "1", 0);
assert.equal(openAt(s.flow, "a"), s.flow);

// The Recommended chip: a question's choice, by place, only one the card has.
assert.equal(recommendedOf(question), null);
assert.equal(recommendedOf({ ...question, recommended: 1 }), 1);
assert.equal(recommendedOf({ ...question, recommended: 3 }), null);
assert.equal(recommendedOf({ ...done, recommended: 0 }), null);

// The Inbox closing or the desk leaving "open" takes a waiting answer back: nothing goes later,
// and the card is there to answer again. Nothing waiting, nothing changes.
s = press(begin([question, ask], 0), "2", 0);
f = takeBack(s.flow, 900);
assert.deepEqual([f.phase, f.pick, current(f)?.id], ["ask", null, "q"]);
assert.deepEqual(tick(f, 9000).out, []);
const idle = begin([question], 0);
assert.equal(takeBack(idle, 5), idle);
s = tick(press(begin([done], 0), "1", 0).flow, WAIT_MS);
assert.equal(takeBack(s.flow, WAIT_MS + 1).phase, "sent");

// A new list that puts a different card in front: 1, 2, 3 and E rest a moment, so a "1" meant
// for the question can't say yes to the approval now in its place; J, K and Esc still work.
f = refresh(begin([question, ask], 0), [ask, done], 1000);
assert.equal(current(f)?.id, "a");
for (const key of ["1", "2", "3", "e"])
  assert.equal(press(f, key, 1000 + SETTLE_MS - 1).flow, f);
assert.equal(current(press(f, "j", 1100).flow)?.id, "f");
assert.equal(press(f, "1", 1000 + SETTLE_MS).flow.phase, "wait");
// A list that keeps the card in front leaves its keys alone.
f = refresh(begin([question, ask], 0), [card("new"), question, ask], 1000);
assert.equal(press(f, "1", 1001).flow.phase, "wait");

console.log("inboxFlow: ok");
