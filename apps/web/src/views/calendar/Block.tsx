// One event on Calendar's grid: a block in its day's column, a bar in the all-day row, or a line in
// a month's day. Each is a button that opens the event's popover, in its calendar's colour; a focus
// block has the task mark, and one Pip put there has Pip's. One you can move has the grab cursor,
// and a block its bottom edge to stretch; while it's held it's drawn where it would land.

import { type Accessor, createMemo, For, type JSX, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { endsOn, spanOf } from "../../lib/calDrag.ts";
import type { Grab, Held, TileDrag } from "../../lib/calHold.ts";
import { type Lane, minuteOf, type Placed } from "../../lib/calLayout.ts";
import { timeNow } from "../../lib/clock.ts";
import { hours, time } from "../../lib/format.ts";
import type { CalEvent } from "../../lib/types.ts";
import { evColour, eventLabel, tint } from "./parts.tsx";

/** Opens an event's popover beside what was clicked. */
export type OpenEvent = (e: CalEvent, at: HTMLElement) => void;

/**
 * Draws each event's place once, kept by the event rather than by where it is: read again
 * unchanged, or moved by another event, it's the same button, so the focus stays on it.
 */
export function ByEvent<P extends { item: CalEvent }>(props: {
  each: readonly P[];
  children: (place: Accessor<P>) => JSX.Element;
}) {
  const at = createMemo(() => new Map(props.each.map((p) => [p.item, p])));
  return (
    <For each={[...at().keys()]}>
      {(e) => {
        // As it was last, while it's on its way out.
        let last = at().get(e)!;
        return props.children(() => {
          last = at().get(e) ?? last;
          return last;
        });
      }}
    </For>
  );
}

/**
 * A button on the grid that the kit has no part for, being a tile in a day's place: an event, or
 * a time Pip suggests (Suggested.tsx). Named for a screen reader by `label`.
 */
export function GridButton(props: {
  class: string;
  style?: JSX.CSSProperties;
  label: string;
  onPointerDown?: (ev: PointerEvent) => void;
  onClick: (el: HTMLElement) => void;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      class={`min-w-0 text-left ${props.class}`}
      style={props.style}
      aria-label={props.label}
      onPointerDown={(ev) => props.onPointerDown?.(ev)}
      onClick={(ev) => props.onClick(ev.currentTarget)}
    >
      {props.children}
    </button>
  );
}

/**
 * The button every event on the grid is, whatever its shape: in its calendar's colour, named for a
 * screen reader by what and when, and opening its popover beside it.
 */
function Tile(props: {
  e: CalEvent;
  class: string;
  style?: JSX.CSSProperties;
  onOpen: OpenEvent;
  drag?: TileDrag;
  /** Its look while it's held. */
  held?: string | false;
  children: JSX.Element;
}) {
  const grab = () => (props.drag?.can ? "cursor-grab select-none" : "");
  return (
    <GridButton
      class={`hover:shadow-2 ${props.held || grab()} ${props.class}`}
      style={{ ...evColour(props.e), ...props.style }}
      label={eventLabel(props.e)}
      onPointerDown={(ev) => props.drag?.can && props.drag.press(ev)}
      onClick={(el) => props.onOpen(props.e, el)}
    >
      {props.children}
    </GridButton>
  );
}

/** Pip's mark and the task mark, before a title. */
function Marks(props: { e: CalEvent }) {
  return (
    <>
      <Show when={props.e.madeByPip}>
        <JarvisMark size={10} label="Pip put this here" />
      </Show>
      <Show when={props.e.taskId}>
        <Icon name="tasks" size={11} class="text-muted" />
      </Show>
    </>
  );
}

/** A timed event in its day's column (`day`), `hour` px to an hour. Over, it's quieter. */
export function Block(props: {
  placed: Placed<CalEvent>;
  day: Date;
  hour: number;
  onOpen: OpenEvent;
  drag?: TileDrag;
  /** Where it would land, while it's held. */
  held?: Held<Grab>;
}) {
  const e = () => props.placed.item;
  const p = () => props.placed;
  const h = () => props.held;
  const start = () => h()?.start ?? new Date(e().startsAt);
  const end = () => h()?.end ?? new Date(e().endsAt);
  // Its bottom edge dragged: as tall as it would be, and never shorter than the column draws one.
  const bottom = () =>
    h()?.grab.mode === "resize" ? Math.max(minuteOf(end(), props.day), p().top + 20) : p().bottom;
  const px = (minutes: number) => (minutes / 60) * props.hour;
  const tall = () => px(bottom() - p().top) >= 34;
  const over = () => Date.parse(e().endsAt) <= timeNow().getTime();
  const meta = () =>
    [hours(start(), end()), e().prepId ? "Prep ready" : null].filter(Boolean).join(" · ");
  const lifted = () =>
    h() && `z-5 shadow-3 ${h()?.grab.mode === "resize" ? "cursor-ns-resize" : "cursor-grabbing"}`;
  return (
    <Tile
      e={e()}
      class={`absolute overflow-hidden rounded-sm px-1.5 py-0.5 text-meta ${tint(e())} ${over() && !h() ? "opacity-70" : ""}`}
      style={{
        top: `${px(p().top) + 1}px`,
        height: `${px(bottom() - p().top) - 2}px`,
        left: `calc(${(p().col / p().cols) * 100}% + 2px)`,
        width: `calc(${(p().span / p().cols) * 100}% - 4px)`,
        ...(h() ? { transform: `translate(${h()?.dx}px, ${h()?.dy}px)` } : {}),
      }}
      onOpen={props.onOpen}
      drag={props.drag}
      held={lifted()}
    >
      <span class="flex min-w-0 items-center gap-1 font-medium">
        <Marks e={e()} />
        <span class="truncate">
          {e().title}
          <Show when={!tall()}>
            <span class="font-normal text-muted">, {time(start())}</span>
          </Show>
        </span>
      </span>
      <Show when={tall()}>
        <span class="block truncate text-muted">{meta()}</span>
      </Show>
      <Show when={props.drag?.can && endsOn(spanOf(e()), props.day)}>
        <span
          data-resize
          aria-hidden="true"
          class="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
        />
      </Show>
    </Tile>
  );
}

/** An all-day event in the row above the hours, across its days; cut square where it runs on. */
export function AllDayBar(props: {
  lane: Lane<CalEvent>;
  onOpen: OpenEvent;
  drag?: TileDrag;
  held?: Held<Grab>;
}) {
  const l = () => props.lane;
  return (
    <Tile
      e={l().item}
      class={`mx-0.5 flex items-center gap-1 rounded-sm px-1.5 text-meta font-medium ${tint(l().item)} ${l().before ? "ml-0 rounded-l-none" : ""} ${l().after ? "mr-0 rounded-r-none" : ""}`}
      style={{
        "grid-column": `${l().col + 1} / span ${l().span}`,
        "grid-row": `${l().lane + 1}`,
        ...(props.held ? { transform: `translateX(${props.held.dx}px)` } : {}),
      }}
      onOpen={props.onOpen}
      drag={props.drag}
      held={props.held && "z-5 shadow-3 cursor-grabbing"}
    >
      <Marks e={l().item} />
      <span class="truncate">{l().item.title}</span>
    </Tile>
  );
}

/** An event in a month's day: a bar for an all-day one, else a dot, its time and its name. */
export function MonthItem(props: {
  e: CalEvent;
  long: boolean;
  onOpen: OpenEvent;
  drag?: TileDrag;
  /** It's being dragged to another day: it stays here, faded, till it's dropped. */
  held?: boolean;
}) {
  const e = () => props.e;
  const look = () =>
    props.long
      ? `font-medium ${tint(e())}`
      : `hover:bg-sunk ${e().selfResponse === "declined" ? "line-through opacity-60" : ""}`;
  return (
    <Tile
      e={e()}
      class={`flex shrink-0 items-center gap-1 rounded-sm px-1 text-micro leading-4 ${look()}`}
      onOpen={props.onOpen}
      drag={props.drag}
      held={props.held && "cursor-grabbing opacity-50"}
    >
      <Show when={!props.long}>
        <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-[var(--ev)]" />
        <span class="shrink-0 text-muted tabular-nums">{time(new Date(e().startsAt))}</span>
      </Show>
      <Marks e={e()} />
      <span class="truncate">{e().title}</span>
    </Tile>
  );
}
