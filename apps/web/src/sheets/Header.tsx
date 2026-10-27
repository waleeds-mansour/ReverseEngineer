// A spreadsheet's column letters along the top. Dragging one's right edge sets that column's width,
// saved with the sheet; the columns frozen at the left stay put while the rest scrolls under them.

import { columnName } from "@hearth/core";
import { For } from "solid-js";
import type { Range } from "./grid.ts";
import type { Sheet } from "./state.ts";

export function Header(props: {
  sheet: Sheet;
  tab: number;
  cols: number[];
  width: (col: number) => number;
  range: Range;
  /** How far from the left a frozen column stays, or null when it scrolls. */
  frozenAt: (col: number) => number | null;
  /** How many columns are frozen. */
  frozenCols: number;
}) {
  // Dragging a column header's right edge sets its width.
  const resize = (col: number, e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const from = props.width(col);
    let to = from;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const th = el.parentElement!.parentElement!;
    const moveIt = (m: PointerEvent) => {
      to = Math.min(800, Math.max(30, from + m.clientX - start));
      th.style.width = `${to}px`;
      th.style.minWidth = `${to}px`;
    };
    const up = () => {
      el.removeEventListener("pointermove", moveIt);
      el.removeEventListener("pointerup", up);
      const tab = props.tab;
      if (to !== from)
        props.sheet.change((d) => {
          d.sheets[tab]!.widths[columnName(col)] = Math.round(to);
        });
    };
    el.addEventListener("pointermove", moveIt);
    el.addEventListener("pointerup", up);
  };

  return (
    <thead>
      <tr>
        <th class="sticky top-0 left-0 z-20 h-6 w-10 min-w-10 border-r border-b border-line bg-sunk" />
        <For each={props.cols}>
          {(c) => {
            const left = () => props.frozenAt(c);
            return (
              <th
                class="sticky top-0 h-6 border-r border-b border-line bg-sunk px-1 text-xs font-normal text-muted"
                classList={{
                  "text-ink": c >= props.range.left && c <= props.range.right,
                  "z-10": left() === null,
                  "z-20": left() !== null,
                  "border-r-border-strong": c === props.frozenCols,
                }}
                style={{
                  width: `${props.width(c)}px`,
                  "min-width": `${props.width(c)}px`,
                  left: left() === null ? undefined : `${left()}px`,
                }}
              >
                <div class="relative">
                  {columnName(c)}
                  <div
                    class="absolute -right-1 top-0 h-full w-2 cursor-col-resize"
                    onPointerDown={(e) => resize(c, e)}
                  />
                </div>
              </th>
            );
          }}
        </For>
      </tr>
    </thead>
  );
}
