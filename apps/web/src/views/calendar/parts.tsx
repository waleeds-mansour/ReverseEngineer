// What Calendar's views share: how an event's day and time are said, its calendar's colour as the
// grid draws it, and who's coming with each one's answer.

import { For, type JSX, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { daysOn } from "../../lib/calLayout.ts";
import { hours, span } from "../../lib/format.ts";
import { unanswered } from "../../lib/today.ts";
import type { CalEvent } from "../../lib/types.ts";
import type { EventDraft } from "../../lib/when.ts";

export const dayLabel = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });

/** "Wednesday, Oct 7, 4 to 4:30 p.m.", or both days for an event that runs past midnight. */
export const when = (start: Date, end: Date) =>
  start.toDateString() === end.toDateString()
    ? `${dayLabel(start)}, ${hours(start, end)}`
    : span(start, end);

/** When an event is: its times, or its day (or days) and "all day". */
export function eventWhen(e: Pick<CalEvent, "startsAt" | "endsAt" | "allDay">): string {
  const start = new Date(e.startsAt);
  if (!e.allDay) return when(start, new Date(e.endsAt));
  // An all-day event ends at the midnight after its last day.
  const last = daysOn(new Date(e.endsAt), -1);
  return last > start
    ? `${dayLabel(start)} to ${dayLabel(last)}, all day`
    : `${dayLabel(start)}, all day`;
}

/** When a typed event is, before it's added: "Friday, Oct 9, 3 to 4 p.m." */
export const planned = (ev: EventDraft) =>
  ev.allDay
    ? `${dayLabel(new Date(`${ev.start}T00:00`))}, all day`
    : when(new Date(ev.start), new Date(ev.end));

/** A calendar's colour as Google gives it, or none if it isn't one ("#9fe1e7"). */
export const colour = (c: string | null | undefined) =>
  c && /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined;

/** An event's colour for the grid to draw with (as --ev): its calendar's, or Calendar's own. */
export const evColour = (e: CalEvent): JSX.CSSProperties => ({
  "--ev": colour(e.calendarColor) ?? "var(--color-calendar)",
});

/**
 * An event's look on the grid: a tint of its colour, edged in it. One waiting for your answer is
 * hollow with a dashed edge, as Google draws it; one you said no to is struck through and faded.
 */
export function tint(e: CalEvent): string {
  const look = unanswered(e)
    ? "border border-dashed border-[color:var(--ev)] bg-panel"
    : "border-l-[3px] border-l-[color:var(--ev)] bg-[color-mix(in_srgb,var(--ev)_16%,var(--color-surface-1))]";
  return `${look} ${e.selfResponse === "declined" ? "line-through opacity-60" : ""}`;
}

/** What a screen reader hears for an event on the grid: its name, when, and your answer if no. */
export const eventLabel = (e: CalEvent) =>
  [
    e.title,
    eventWhen(e),
    unanswered(e) ? "not answered" : e.selfResponse === "declined" ? "not going" : null,
  ]
    .filter(Boolean)
    .join(", ");

/** A day's date in a circle, on the accent when it's today; `quiet` for another month's. */
export function DateMark(props: { day: Date; today: boolean; quiet?: boolean; class?: string }) {
  const look = () =>
    props.today ? "bg-accent font-semibold text-on-accent" : props.quiet ? "text-faint" : "";
  return (
    <span
      class={`flex shrink-0 items-center justify-center rounded-full ${look()} ${props.class ?? ""}`}
    >
      {props.day.getDate()}
    </span>
  );
}

/** The tick or cross after the name of someone who has answered an invitation. */
const ANSWERED = "ml-0.5 inline align-[-2px]";

/** "With Sam ✓, Priya ✗, Lee": the guests besides you, each with the answer they gave. */
export function Guests(props: { event: CalEvent; class?: string }) {
  const others = () => props.event.attendees.filter((a) => !a.self);
  return (
    <Show when={others().length > 0}>
      <p class={props.class ?? "text-muted"}>
        With{" "}
        <For each={others()}>
          {(a, i) => (
            <>
              {i() > 0 ? ", " : ""}
              {a.name ?? a.email}
              <Show when={a.response === "accepted"}>
                <Icon name="check" size={14} label="(going)" class={`${ANSWERED} text-ok`} />
              </Show>
              <Show when={a.response === "declined"}>
                <Icon name="x" size={14} label="(not going)" class={`${ANSWERED} text-bad`} />
              </Show>
            </>
          )}
        </For>
      </p>
    </Show>
  );
}
