// Calendar's week and day: a column a day under the hours, with all-day events in a row above
// them. Events that overlap sit side by side; the line for now crosses today's column and moves
// with the clock. It opens scrolled to 7 a.m., and keeps its place as you go from week to week.

import { createMemo, For, onMount, Show } from "solid-js";
import { Button } from "../../components/ui.tsx";
import { allDayLanes, dayColumn, inAllDayRow, type Lane, nowMinute } from "../../lib/calLayout.ts";
import { timeNow } from "../../lib/clock.ts";
import { time } from "../../lib/format.ts";
import type { CalEvent } from "../../lib/types.ts";
import { AllDayBar, Block, ByEvent, type OpenEvent } from "./Block.tsx";
import { DateMark, dayLabel } from "./parts.tsx";

/** An hour's height, in px. */
const HOUR = 48;
/** The hour at the top when Calendar opens. */
const MORNING = 7;
const HOURS = Array.from({ length: 23 }, (_, i) => i + 1);
/** A line on the hour, drawn under each day's column. */
const LINES = {
  "background-image": "linear-gradient(to bottom, var(--color-hairline) 1px, transparent 1px)",
  "background-size": `100% ${HOUR}px`,
};

export function TimeGrid(props: {
  days: Date[];
  events: readonly CalEvent[];
  /** The start of today, as a time. */
  today: number;
  /** Days outside the ones Nook keeps are shaded. */
  kept: (day: Date) => boolean;
  onOpen: OpenEvent;
  /** A day's name was clicked: that day, on its own. */
  onDay: (day: Date) => void;
}) {
  let scroller!: HTMLDivElement;
  onMount(() => {
    scroller.scrollTop = MORNING * HOUR;
  });
  const timed = createMemo(() => props.events.filter((e) => !inAllDayRow(e)));
  const lanes = createMemo(() => allDayLanes(props.events.filter(inAllDayRow), props.days));
  const columns = () => ({
    "grid-template-columns": `3.5rem repeat(${props.days.length}, minmax(0, 1fr))`,
  });
  return (
    <div ref={scroller} class="h-full overflow-y-auto">
      <div class="sticky top-0 z-10 grid border-b border-line bg-panel" style={columns()}>
        <span />
        <For each={props.days}>
          {(d) => (
            <DayName
              day={d}
              today={d.getTime() === props.today}
              alone={props.days.length === 1}
              onDay={props.onDay}
            />
          )}
        </For>
        <AllDayRow lanes={lanes()} count={props.days.length} onOpen={props.onOpen} />
      </div>
      <div class="grid" style={{ ...columns(), height: `${24 * HOUR}px` }}>
        <div class="relative" aria-hidden="true">
          <For each={HOURS}>
            {(h) => (
              <span
                class="absolute right-2 -translate-y-1/2 text-micro whitespace-nowrap text-faint"
                style={{ top: `${h * HOUR}px` }}
              >
                {time(new Date(2000, 0, 1, h))}
              </span>
            )}
          </For>
        </div>
        <For each={props.days}>
          {(d) => (
            <Column
              day={d}
              events={timed()}
              today={d.getTime() === props.today}
              kept={props.kept(d)}
              onOpen={props.onOpen}
            />
          )}
        </For>
      </div>
    </div>
  );
}

/** A day's name over its column, "Tue 27", which opens that day on its own; today on the accent. */
function DayName(props: { day: Date; today: boolean; alone: boolean; onDay: (d: Date) => void }) {
  const name = () => (
    <>
      <span class="truncate text-micro font-semibold text-muted uppercase">
        {props.day.toLocaleDateString("en-US", { weekday: "short" })}
      </span>
      <DateMark day={props.day} today={props.today} class="size-6 text-callout" />
    </>
  );
  return (
    <div class="flex min-w-0 items-center justify-center border-l border-line px-0.5 py-1">
      <Show when={!props.alone} fallback={<span class="flex items-center gap-1.5">{name()}</span>}>
        <Button
          variant="quiet"
          class="max-w-full min-w-0"
          label={`${dayLabel(props.day)}${props.today ? ", today" : ""}`}
          onClick={() => props.onDay(props.day)}
        >
          {name()}
        </Button>
      </Show>
    </div>
  );
}

/** The all-day row: a lane per line of events that run all day, under the days' names. */
function AllDayRow(props: { lanes: Lane<CalEvent>[]; count: number; onOpen: OpenEvent }) {
  const rows = () => props.lanes.reduce((n, l) => Math.max(n, l.lane + 1), 0);
  return (
    <Show when={rows() > 0}>
      <span class="self-start py-1 pr-2 text-right text-micro text-faint">all day</span>
      <div
        class="grid gap-y-0.5 py-0.5"
        style={{
          "grid-column": `2 / span ${props.count}`,
          "grid-template-columns": `repeat(${props.count}, minmax(0, 1fr))`,
          "grid-auto-rows": "1.25rem",
        }}
      >
        <ByEvent each={props.lanes}>
          {(l) => <AllDayBar lane={l()} onOpen={props.onOpen} />}
        </ByEvent>
      </div>
    </Show>
  );
}

/** A day's column: its timed events, packed side by side where they overlap, and now's line. */
function Column(props: {
  day: Date;
  events: readonly CalEvent[];
  today: boolean;
  kept: boolean;
  onOpen: OpenEvent;
}) {
  const placed = createMemo(() => dayColumn(props.events, props.day));
  return (
    <div class={`relative border-l border-line ${props.kept ? "" : "bg-sunk/60"}`} style={LINES}>
      <ByEvent each={placed()}>
        {(p) => <Block placed={p()} hour={HOUR} onOpen={props.onOpen} />}
      </ByEvent>
      <Show when={props.today}>
        <div
          aria-hidden="true"
          class="pointer-events-none absolute inset-x-0 h-0.5 bg-accent"
          style={{ top: `${(nowMinute(timeNow()) / 60) * HOUR - 1}px` }}
        >
          <span class="absolute -top-[3px] -left-1 size-2 rounded-full bg-accent" />
        </div>
      </Show>
    </div>
  );
}
