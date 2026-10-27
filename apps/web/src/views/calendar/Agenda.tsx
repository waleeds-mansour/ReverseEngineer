// Calendar on a phone: what's shown as a list, day by day, with focus blocks, answers and "Prep
// ready" marked; an invitation you haven't answered is answered right on its row. An event's page
// opens with its prep, when Pip has written one.

import { createMemo, For, type JSX, Show } from "solid-js";
import { InviteAnswers } from "../../components/InviteAnswers.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { Badge, TextButton } from "../../components/ui.tsx";
import { plural, time } from "../../lib/format.ts";
import { layout } from "../../lib/panes.ts";
import { unanswered } from "../../lib/today.ts";
import type { CalEvent } from "../../lib/types.ts";
import { byDay } from "../../lib/week.ts";
import { colour, dayLabel } from "./parts.tsx";

/** The events from `from` to `to`, by day; `empty` when there are none. */
export function Agenda(props: {
  events: readonly CalEvent[];
  from: Date;
  to: Date;
  pane: number;
  empty: JSX.Element;
}) {
  const shown = createMemo(() =>
    props.events.filter(
      (e) =>
        Date.parse(e.startsAt) < props.to.getTime() && Date.parse(e.endsAt) > props.from.getTime(),
    ),
  );
  const week = byDay(shown, () => props.from);
  return (
    <Show when={week.days().length > 0} fallback={props.empty}>
      <For each={week.days()}>
        {(day) => (
          <section>
            <h2 class="sticky top-0 bg-panel px-4 pt-3 pb-1 text-xs font-semibold text-muted uppercase">
              {dayLabel(new Date(day))}
            </h2>
            <ul>
              <For each={week.on(day)}>{(e) => <Row event={e} pane={props.pane} />}</For>
            </ul>
          </section>
        )}
      </For>
    </Show>
  );
}

/** One event: when, its calendar's colour, what, where, and Join for a video call. */
function Row(props: { event: CalEvent; pane: number }) {
  const e = () => props.event;
  const guests = () => e().attendees.filter((a) => !a.self).length;
  return (
    <li
      class="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line px-4 py-2"
      onClick={() =>
        layout.open({ view: "record", id: e().id }, { beside: true, pane: props.pane })
      }
    >
      <span class="w-20 shrink-0 text-xs text-muted tabular-nums">
        {e().allDay ? "all day" : time(new Date(e().startsAt))}
      </span>
      <span
        class="size-2 shrink-0 self-center rounded-full bg-line"
        style={{ "background-color": colour(e().calendarColor) }}
        aria-hidden="true"
      />
      <span class="min-w-0 flex-1">
        <span
          class={`block truncate ${e().selfResponse === "declined" ? "line-through opacity-60" : ""}`}
        >
          {e().title}
        </span>
        <span class="block truncate text-xs text-faint">
          {[e().allDay ? null : `until ${time(new Date(e().endsAt))}`, e().location]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </span>
      <Show when={e().madeByPip}>
        <JarvisMark size={14} label="Pip put this here" class="self-center" />
      </Show>
      <Show when={e().taskId}>
        <Badge>focus</Badge>
      </Show>
      <Show when={e().prepId}>
        <Badge tone="positive">Prep ready</Badge>
      </Show>
      <Show when={guests() > 0}>
        <span class="text-xs text-faint">{plural(guests(), "guest")}</span>
      </Show>
      <Show when={e().meetUrl}>
        {(url) => (
          <TextButton
            alone
            class="text-xs"
            href={url()}
            target="_blank"
            onClick={(ev) => ev.stopPropagation()}
          >
            Join
          </TextButton>
        )}
      </Show>
      {/* Not answered yet: answered right here, under its name on a phone. */}
      <Show when={unanswered(e())}>
        <InviteAnswers
          eventId={e().id}
          response={e().selfResponse}
          recurring={e().recurringEventId !== null}
          class="w-full pl-23 md:w-auto md:pl-0"
        />
      </Show>
    </li>
  );
}
