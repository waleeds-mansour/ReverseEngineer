// Calendar's month: six weeks of days, each with up to three of its events and then "+N more",
// which opens that day. A day's date opens it too. Days of other months are quieter, days Nook
// doesn't keep are shaded, and today's date is on the accent.

import { createMemo, For, Show } from "solid-js";
import { Button, TextButton } from "../../components/ui.tsx";
import { fitCell, inAllDayRow, onDay } from "../../lib/calLayout.ts";
import type { CalEvent } from "../../lib/types.ts";
import { MonthItem, type OpenEvent } from "./Block.tsx";
import { DateMark, dayLabel } from "./parts.tsx";

export function MonthGrid(props: {
  days: Date[];
  month: Date;
  events: readonly CalEvent[];
  today: number;
  kept: (day: Date) => boolean;
  onOpen: OpenEvent;
  onDay: (day: Date) => void;
}) {
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
      <div class="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        <For each={props.days}>
          {(d) => (
            <Day
              day={d}
              events={props.events}
              inMonth={d.getMonth() === props.month.getMonth()}
              today={d.getTime() === props.today}
              kept={props.kept(d)}
              onOpen={props.onOpen}
              onDay={props.onDay}
            />
          )}
        </For>
      </div>
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
}) {
  const fit = createMemo(() => fitCell(onDay(props.events, props.day)));
  const name = () => `${dayLabel(props.day)}${props.today ? ", today" : ""}`;
  return (
    <div
      class={`flex min-h-0 min-w-0 flex-col gap-px overflow-hidden border-b border-l border-line p-1 [&:nth-child(7n+1)]:border-l-0 ${props.kept ? "" : "bg-sunk/60"}`}
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
        {(e) => <MonthItem e={e} long={inAllDayRow(e)} onOpen={props.onOpen} />}
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
