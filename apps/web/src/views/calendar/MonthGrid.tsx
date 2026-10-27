// Calendar's month: six weeks of days, each with up to three of its events and then "+N more",
// which opens that day. A day's date opens it too. Days of other months are quieter, days Nook
// doesn't keep are shaded, and today's date is on the accent. An event you can change drags to
// another day at the same time: its name follows the pointer, and the day it would go to lights up.

import { createEffect, createMemo, For, on, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Button, TextButton } from "../../components/ui.tsx";
import { cellAt, moveDays, type Span, spanOf } from "../../lib/calDrag.ts";
import { createDrag, type Grab, type TileDrag } from "../../lib/calHold.ts";
import { fitCell, inAllDayRow, onDay } from "../../lib/calLayout.ts";
import type { CalEvent } from "../../lib/types.ts";
import { MonthItem, type OpenEvent } from "./Block.tsx";
import { DateMark, dayLabel } from "./parts.tsx";

/** A press on a month's event, with the day cells where they were then. */
interface CellGrab extends Grab {
  cells: DOMRect[];
}

export function MonthGrid(props: {
  days: Date[];
  month: Date;
  events: readonly CalEvent[];
  today: number;
  kept: (day: Date) => boolean;
  onOpen: OpenEvent;
  onDay: (day: Date) => void;
  /** Whether an event can be dragged, and where one was dropped. */
  canMove: (e: CalEvent) => boolean;
  onMove: (e: CalEvent, to: Span, at: DOMRect) => void;
}) {
  let grid!: HTMLDivElement;
  const drag = createDrag<CellGrab>({
    land(g, x, y) {
      const i = cellAt(x, y, g.cells);
      const to = props.days[i];
      const box = g.cells[i];
      return {
        ...(to ? moveDays(spanOf(g.e), g.day, to) : spanOf(g.e)),
        dx: x - g.x,
        dy: y - g.y,
        over: i,
        ...(box ? { box } : {}),
      };
    },
    drop: (e, to, at) => props.onMove(e, to, at),
  });
  // Other days shown under a held event (the day turned): it goes back rather than land there.
  createEffect(on(() => props.days, drag.cancel, { defer: true }));
  const tile = (e: CalEvent, day: Date): TileDrag => ({
    can: props.canMove(e),
    press: (ev) =>
      drag.press(ev, {
        e,
        mode: "move",
        day,
        cells: [...grid.querySelectorAll("[data-day-cell]")].map((c) => c.getBoundingClientRect()),
      }),
  });
  const held = (e: CalEvent, day: Date) => {
    const g = drag.held()?.grab;
    return g?.e.id === e.id && g.day.getTime() === day.getTime();
  };
  return (
    <div class="flex h-full min-h-[30rem] flex-col">
      <div class="grid grid-cols-7 border-b border-line">
        <For each={props.days.slice(0, 7)}>
          {(d) => (
            <span class="truncate border-l border-line px-2 py-1 text-micro font-semibold text-muted uppercase first:border-l-0">
              {d.toLocaleDateString("en-US", { weekday: "short" })}
            </span>
          )}
        </For>
      </div>
      <div ref={grid} class="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        <For each={props.days}>
          {(d, i) => (
            <Day
              day={d}
              events={props.events}
              inMonth={d.getMonth() === props.month.getMonth()}
              today={d.getTime() === props.today}
              kept={props.kept(d)}
              onOpen={props.onOpen}
              onDay={props.onDay}
              drag={tile}
              held={held}
              over={drag.held()?.over === i()}
            />
          )}
        </For>
      </div>
      <Show when={drag.held()}>
        {(h) => (
          <Portal>
            <div
              aria-hidden="true"
              class="glass-strong pointer-events-none fixed z-(--z-popup) max-w-48 truncate rounded-sm px-2 py-0.5 text-micro font-medium shadow-4"
              style={{ top: `${h().y + 10}px`, left: `${h().x + 12}px` }}
            >
              {h().grab.e.title}
            </div>
          </Portal>
        )}
      </Show>
    </div>
  );
}

function Day(props: {
  day: Date;
  events: readonly CalEvent[];
  inMonth: boolean;
  today: boolean;
  kept: boolean;
  onOpen: OpenEvent;
  onDay: (day: Date) => void;
  drag: (e: CalEvent, day: Date) => TileDrag;
  held: (e: CalEvent, day: Date) => boolean;
  /** An event being dragged would go here. */
  over: boolean;
}) {
  const fit = createMemo(() => fitCell(onDay(props.events, props.day)));
  const name = () => `${dayLabel(props.day)}${props.today ? ", today" : ""}`;
  return (
    <div
      data-day-cell
      class={`flex min-h-0 min-w-0 flex-col gap-px overflow-hidden border-b border-l border-line p-1 [&:nth-child(7n+1)]:border-l-0 ${props.over ? "bg-accent-soft" : props.kept ? "" : "bg-sunk/60"}`}
    >
      <Button
        variant="quiet"
        size="sm"
        class="shrink-0 self-start"
        label={name()}
        onClick={() => props.onDay(props.day)}
      >
        <DateMark day={props.day} today={props.today} quiet={!props.inMonth} class="size-5" />
      </Button>
      <For each={fit().shown}>
        {(e) => (
          <MonthItem
            e={e}
            long={inAllDayRow(e)}
            onOpen={props.onOpen}
            drag={props.drag(e, props.day)}
            held={props.held(e, props.day)}
          />
        )}
      </For>
      <Show when={fit().more > 0}>
        <TextButton
          alone
          class="shrink-0 self-start px-1 text-micro"
          label={`${fit().more} more on ${dayLabel(props.day)}`}
          onClick={() => props.onDay(props.day)}
        >
          +{fit().more} more
        </TextButton>
      </Show>
    </div>
  );
}
