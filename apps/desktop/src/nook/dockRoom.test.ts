// A panel taller than the dock's window can hold (dockLayout.ts's panelRoom): its frame and its
// content both stop at the room, so the bottom of a tall chat, its field, stays in view. Run: bun
// src/nook/dockRoom.test.ts
import assert from "node:assert/strict";
import type { ChromeView } from "@/bindings";
import { boxFor } from "./dockLip";
import { panelRoom } from "./dockLayout";
import { PANEL } from "./dockShape";

// A 1080p screen at 125 % with the dock at 150 %: about 544 CSS px of work area.
const high = 544;
const room = panelRoom(high);
assert.equal(room, 544 - 2 * (36 + 10 + 12) - 2 * 16);

const chrome = {
  agents: [{}, {}, {}],
  bar: { shown: false },
} as unknown as ChromeView;
for (const mid of [60, 272, 500]) {
  const box = boxFor(
    chrome,
    { open: true, mid, high },
    { wide: 420, tall: 560 },
    null,
    0,
  );
  assert.ok(box && box.kind === "panel");
  const { top, bottom } = box.at;
  // The frame holds the room and no more, inside the work area.
  assert.equal(Math.round(bottom - top - 2 * PANEL.pad), room, `mid ${mid}`);
  assert.ok(top >= 0 && bottom <= high, `mid ${mid}: ${top}..${bottom}`);
}

// A short panel keeps its own height.
const short = boxFor(
  chrome,
  { open: true, mid: 272, high },
  { wide: 320, tall: 60 },
  null,
  0,
);
assert.equal(short && short.at.bottom - short.at.top, 60 + 2 * PANEL.pad);
// A big screen holds the tallest panel.
assert.ok(panelRoom(1400) >= 640);

console.log("dockRoom: all assertions passed");
