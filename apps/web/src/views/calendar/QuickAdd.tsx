// The box at the top of Calendar that adds an event from a line like "Dentist Fri 3pm 1h", and what
// Calendar says about days with nothing on, or days it doesn't keep: never "free" when Nook
// wouldn't know.

import { createMemo, createSignal, Show } from "solid-js";
import { Notice } from "../../components/kit/Notice.tsx";
import { QueryView } from "../../components/QueryView.tsx";
import { Badge, Empty } from "../../components/ui.tsx";
import { emptyWeek, notKept, pastKept } from "../../lib/emptyWeek.ts";
import { toast } from "../../lib/live.ts";
import { act, useAction } from "../../lib/query.ts";
import { quickAdd } from "../../lib/quickadd.ts";
import type { CalendarSetup } from "../../lib/types.ts";
import { syncedFrom, syncedUntil } from "../../lib/week.ts";
import { readEvent } from "../../lib/when.ts";
import { planned } from "./parts.tsx";

/** The box that adds an event from a line of text; one with guests still goes through Pip. */
export function NewEvent() {
  const [text, setText] = createSignal("");
  const read = createMemo(() => readEvent(text().trim()));
  const add = async () => {
    if (!text().trim()) return;
    // Read again as it's added, so "in 20 min" counts from now.
    const ev = readEvent(text().trim());
    if (!ev) return toast.show("Say when, like “Dentist Fri 3pm 1h”.");
    const made = await quickAdd({ get: text, set: setText }, () =>
      act("calendar.create_event", { title: ev.title, start: ev.start, end: ev.end }),
    );
    if (made) toast.show(`Added ${ev.title}: ${planned(ev)}.`);
  };
  return (
    <form
      class="flex items-center gap-2 border-b border-line px-4 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <input
        class="min-w-0 flex-1 bg-transparent py-1 placeholder:text-faint"
        aria-label="New event"
        placeholder="New event… “Dentist Fri 3pm 1h”"
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      <Show when={read()}>
        {(ev) => (
          <Badge tone="accent" icon="calendar">
            {planned(ev())}
          </Badge>
        )}
      </Show>
    </form>
  );
}

/**
 * A week with nothing on, in words that don't call it free when Nook wouldn't know: loading, or
 * Try again, till it knows what's connected. Over the grid it's a strip; in the list, the list.
 */
export function NoEvents(props: { from: Date; today: Date; strip?: boolean }) {
  const setup = useAction<CalendarSetup>("calendar.calendars");
  const out = () => notKept(props.from, props.today);
  const say = (text: string) =>
    props.strip ? <Notice strip>{text}</Notice> : <Empty>{text}</Empty>;
  return (
    <Show when={!out()} fallback={say(out() ?? "")}>
      <Show
        when={props.strip}
        fallback={
          <QueryView query={setup} what="your calendars">
            {(s) => <Empty>{emptyWeek(props.from, props.today, s())}</Empty>}
          </QueryView>
        }
      >
        <Show when={setup.data}>
          {(s) => <Notice strip>{emptyWeek(props.from, props.today, s())}</Notice>}
        </Show>
      </Show>
    </Show>
  );
}

/** Days shown that Nook doesn't keep (before 7 days back, past 60 ahead): where to look instead. */
export function NotKept(props: { from: Date; to: Date; today: Date }) {
  const until = () => syncedUntil(props.today);
  return (
    <>
      <Show when={props.from < syncedFrom(props.today)}>
        <Notice strip>{notKept(props.from, props.today)}</Notice>
      </Show>
      <Show when={props.to > until()}>
        <Notice strip>{pastKept(until())}</Notice>
      </Show>
    </>
  );
}
