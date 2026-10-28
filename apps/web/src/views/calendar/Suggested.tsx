// The times Pip suggests, in a day's column on the grid: dashed blocks on Pip's colour, as long as
// you asked, so they can't pass for events. Clicking one adds it, or asks before inviting your
// guests; they never drag.

import { For, Show } from "solid-js";
import { JarvisMark } from "../../components/Mark.tsx";
import { minuteOf } from "../../lib/calLayout.ts";
import { hours } from "../../lib/format.ts";
import { type Suggestion, suggestedOn, suggestionLabel } from "../../lib/suggest.ts";
import { GridButton } from "./Block.tsx";
import type { Finder } from "./finder.ts";

/** As short as the grid draws an event, so a 15-minute one can still be read and clicked. */
const LEAST = 20;

/** The suggestions on `day`'s column, `hour` px to an hour. */
export function Suggested(props: { day: Date; hour: number; finder: Finder }) {
  const here = () => suggestedOn(props.finder.suggestions(), props.day);
  return (
    <For each={here()}>
      {(s) => <Block s={s} day={props.day} hour={props.hour} finder={props.finder} />}
    </For>
  );
}

function Block(props: { s: Suggestion; day: Date; hour: number; finder: Finder }) {
  const px = (minutes: number) => (minutes / 60) * props.hour;
  const top = () => minuteOf(props.s.start, props.day);
  const length = () => Math.max(minuteOf(props.s.end, props.day) - top(), LEAST);
  const tall = () => px(length()) >= 34;
  return (
    <GridButton
      class="absolute inset-x-0.5 overflow-hidden rounded-sm border border-dashed border-accent bg-accent-soft/80 px-1.5 py-0.5 text-meta text-accent-ink hover:bg-accent-soft hover:shadow-2"
      style={{ top: `${px(top()) + 1}px`, height: `${px(length()) - 2}px` }}
      label={suggestionLabel(props.s, props.finder.guests())}
      onClick={(el) => props.finder.pick(props.s, el.getBoundingClientRect())}
    >
      <span class="flex min-w-0 items-center gap-1 font-medium">
        <JarvisMark size={10} class="shrink-0" />
        <span class="truncate">
          Pip suggests
          <Show when={!tall()}>
            <span class="font-normal">, {hours(props.s.start, props.s.end)}</span>
          </Show>
        </span>
      </span>
      <Show when={tall()}>
        <span class="block truncate">{hours(props.s.start, props.s.end)}</span>
      </Show>
    </GridButton>
  );
}
