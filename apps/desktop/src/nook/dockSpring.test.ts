// The agent dock's springs (dockSpring.ts): how far each swings past its mark and how they read as
// CSS. Run: bun src/nook/dockSpring.test.ts
import assert from "node:assert/strict";
import {
  SPRINGS,
  overshoot,
  settleTime,
  springAt,
  springCss,
  swingAtMost,
} from "./dockSpring";

/** The furthest a spring gets, sampled every millisecond until it settles. */
const peak = (k: number, c: number) => {
  let top = 0;
  for (let t = 0; t <= settleTime(k, c); t += 0.001) {
    top = Math.max(top, springAt(k, c, t));
  }
  return top;
};

// It starts at 0 and ends at 1.
for (const [k, c] of Object.values(SPRINGS)) {
  assert.equal(springAt(k, c, 0), 0);
  assert.ok(Math.abs(springAt(k, c, settleTime(k, c)) - 1) <= 0.004);
}

// The tab springs back out of the edge with a bounce, about 21 % past its mark.
const tab = peak(...SPRINGS.tab);
assert.ok(tab > 1.19 && tab < 1.23, `tab peaks at ${tab}`);
// The pill comes in just past its mark, and the label barely.
const panel = peak(...SPRINGS.panel);
assert.ok(panel > 1 && panel < 1.03, `panel peaks at ${panel}`);
assert.ok(peak(...SPRINGS.general) < 1.01);

// Critical and over-damped springs never pass their mark.
assert.ok(peak(400, 40) <= 1);
assert.ok(peak(400, 60) <= 1);

// As CSS: a linear() easing from 0 to exactly 1, and how long it runs.
const css = springCss(...SPRINGS.tab);
assert.ok(css.easing.startsWith("linear(0, "));
assert.ok(css.easing.endsWith(", 1)"));
assert.equal(css.easing.split(",").length, 49);
assert.ok(css.ms > 400 && css.ms < 800, `the tab's spring runs ${css.ms} ms`);

console.log("dockSpring: all assertions passed");

// overshoot() says what the sampled peak shows.
assert.ok(Math.abs(1 + overshoot(SPRINGS.tab) - tab) < 0.005);
assert.equal(overshoot([400, 40]), 0);
// Kept to a swing it already keeps, a spring is as it was; kept to less, it is damped to swing
// just that far; kept to none, it is critically damped.
assert.deepEqual(swingAtMost(SPRINGS.tab, 0.3), SPRINGS.tab);
const held = swingAtMost(SPRINGS.tab, 0.15);
assert.equal(held[0], SPRINGS.tab[0]);
assert.ok(held[1] > SPRINGS.tab[1]);
assert.ok(
  Math.abs(peak(...held) - 1.15) < 0.005,
  `held peaks at ${peak(...held)}`,
);
assert.equal(overshoot(swingAtMost(SPRINGS.tab, 0)), 0);
