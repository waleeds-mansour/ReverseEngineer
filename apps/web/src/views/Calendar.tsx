// Your calendar: this week as a column a day under the hours (or one day, or a month's six weeks),
// its weeks starting on the day they do where you are, with focus blocks, unanswered invites and
// "Prep ready" marked. An event opens a popover with its details, your answer and its notes; on a
// phone the days are a list instead. The box at the top adds an event to your own calendar from a
// line like "Dentist Fri 3pm 1h"; one with guests still goes through Pip, who asks first. An event
// you can change drags to another time or day, and stretches by its bottom edge; a meeting's guests
// would get an update, so dropping one asks first (lib/calMoves.ts). Find a time puts the times Pip
// suggests in the days shown on the grid (calendar/FindTime.tsx); one with guests asks first too.
// Keys, while Calendar's pane has focus and nothing is being dragged: t today, ← and → earlier and
// later, d, w and m for day, week and month, f to find a time and Esc to clear what it found.

import { batch, createMemo, createSignal, Match, Show, Switch } from "solid-js";
import { QueryView } from "../components/QueryView.tsx";
import { Empty, Failed, PaneHeader } from "../components/ui.tsx";
import { moveQuestion } from "../lib/calDrag.ts";
import { holding } from "../lib/calHold.ts";
import { createMoves } from "../lib/calMoves.ts";
import { createToday } from "../lib/clock.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { narrow } from "../lib/narrow.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import { isPlan } from "../lib/today.ts";
import type { CalEvent } from "../lib/types.ts";
import {
  type CalView,
  createShown,
  emptyNoteFrom,
  focusOf,
  offsetFor,
  rangeLabel,
  type Shown,
  syncedFrom,
  syncedUntil,
} from "../lib/week.ts";
import { Agenda } from "./calendar/Agenda.tsx";
import { EventPopover } from "./calendar/EventPopover.tsx";
import { FindTime } from "./calendar/FindTime.tsx";
import { createFinder } from "./calendar/finder.ts";
import { MonthGrid } from "./calendar/MonthGrid.tsx";
import { MoveConfirm } from "./calendar/MoveConfirm.tsx";
import { NewEvent, NoEvents, NotKept } from "./calendar/QuickAdd.tsx";
import { Suggested } from "./calendar/Suggested.tsx";
import { TimeGrid } from "./calendar/TimeGrid.tsx";
import { Toolbar } from "./calendar/Toolbar.tsx";

/**
 * What the agenda lists of what a view shows (the day, the week, or the month without its edges),
 * what it says when that's empty though the days read around it aren't, and what it calls them.
 */
function listed(view: CalView, s: Shown) {
  if (view === "day")
    return {
      from: s.from,
      to: s.end,
      quiet: "Nothing on your calendar that day.",
      where: "that day",
    };
  if (!s.month)
    return {
      from: s.from,
      to: s.end,
      quiet: "Nothing on your calendar that week.",
      where: "that week",
    };
  const name = s.month.toLocaleDateString("en-US", { month: "long" });
  const to = new Date(s.month.getFullYear(), s.month.getMonth() + 1, 1);
  return { from: s.month, to, quiet: `Nothing on your calendar in ${name}.`, where: `in ${name}` };
}

export function Calendar(props: { pane: number }) {
  const [view, setView] = createSignal<CalView>("week");
  const [offset, setOffset] = createSignal(0);
  const [open, setOpen] = createSignal<{ id: string; at: DOMRect; from: HTMLElement }>();
  // The day turns at midnight, not each minute, so what's drawn by day isn't drawn again till then.
  const today = createToday();
  const day = () => new Date(today());
  const shown = createShown(view, offset);
  const events = useAction<CalEvent[]>("calendar.events", () => ({
    from: shown().from.toISOString(),
    to: shown().to.toISOString(),
  }));
  const plans = createMemo(() => (events.data ?? []).filter(isPlan));
  // What's drawn: each event moved by hand where it was dropped, while Nook saves it.
  const moves = createMoves(plans, () => events.dataUpdatedAt);
  const drawn = moves.shown;
  const list = createMemo(() => listed(view(), shown()));
  const kept = (d: Date) => d >= syncedFrom(day()) && d < syncedUntil(day());
  // Pip's suggested times in the days listed, which are the days drawn but a month's edges.
  const finder = createFinder(() => ({ from: list().from, to: list().to }));
  let root!: HTMLDivElement;

  const go = (by: number | null) => {
    setOpen();
    setOffset(by === null ? 0 : offset() + by);
  };
  /** Shows `next`, about the day this view is about, or about `on`. */
  const show = (next: CalView, on?: Date) => {
    const at = on ?? focusOf(view(), day(), offset());
    batch(() => {
      setOpen();
      setView(next);
      setOffset(offsetFor(next, day(), at));
    });
  };
  // Not while an event is held: the days under it would change, and it would land where you
  // never put it.
  const focused = () => layout.focused() === props.pane && !holding();
  /**
   * Esc clears what Find a time found only when it's Calendar's: the focus is in its pane (or
   * nowhere), and no sheet, menu or palette is open over it, whose own Esc it is.
   */
  const escHere = () => {
    const at = document.activeElement;
    const ours = !at || at === document.body || root.contains(at);
    return ours && !document.querySelector('[aria-modal="true"]');
  };
  /** Opens Find a time, on a week if a month's grid is shown, and puts you in Who. */
  const find = () => {
    if (view() === "month" && !narrow()) show("week");
    finder.show();
    root.querySelector<HTMLElement>("[data-find-who]")?.focus();
  };
  useHotkeys([
    { keys: "t", run: () => go(null), when: focused, label: "Calendar: today" },
    { keys: "arrowleft", run: () => go(-1), when: focused, label: "Calendar: earlier" },
    { keys: "arrowright", run: () => go(1), when: focused, label: "Calendar: later" },
    { keys: "d", run: () => show("day"), when: focused, label: "Calendar: day" },
    { keys: "w", run: () => show("week"), when: focused, label: "Calendar: week" },
    { keys: "m", run: () => show("month"), when: focused, label: "Calendar: month" },
    { keys: "f", run: find, when: focused, label: "Calendar: find a time" },
    {
      keys: "escape",
      run: finder.close,
      // Not while an event or a question is open: Esc is theirs.
      when: () =>
        focused() && finder.open() && !open() && !moves.asking() && !finder.inviting() && escHere(),
      label: "Calendar: clear the times Pip suggests",
    },
  ]);

  // The open event as last read, so its answers and guests stay current while it's open.
  const popover = createMemo(() => {
    const o = open();
    const event = o && drawn().find((e) => e.id === o.id);
    return o && event ? { event, at: o.at } : undefined;
  });
  const onOpen = (e: CalEvent, el: HTMLElement) =>
    setOpen({ id: e.id, at: el.getBoundingClientRect(), from: el });
  const close = (refocus: boolean) => {
    const from = open()?.from;
    setOpen();
    if (refocus && from?.isConnected) from.focus();
  };

  // Nothing on in all that was read: say why, never calling it free when Nook can't know.
  const nothing = () => events.data !== undefined && plans().length === 0;
  const noEvents = (strip: boolean) => (
    <NoEvents from={emptyNoteFrom(shown(), day())} today={day()} strip={strip} />
  );
  const notKept = () => <NotKept from={shown().from} to={shown().end} today={day()} />;

  return (
    <div ref={root} class="flex h-full flex-col" data-product="calendar">
      <PaneHeader
        title="Calendar"
        sub={<span aria-live="polite">{rangeLabel(view(), shown())}</span>}
      >
        <Toolbar view={view()} onView={show} onStep={go} onToday={() => go(null)} onFind={find} />
      </PaneHeader>
      <NewEvent />
      <Show when={finder.open()}>
        <FindTime finder={finder} where={list().where} list={narrow() || view() === "month"} />
      </Show>
      <Show
        when={!narrow()}
        fallback={
          <div class="min-h-0 flex-1 overflow-auto">
            <QueryView query={events} what="your calendar">
              {() => (
                <>
                  <Agenda
                    events={drawn()}
                    from={list().from}
                    to={list().to}
                    pane={props.pane}
                    empty={nothing() ? noEvents(false) : <Empty>{list().quiet}</Empty>}
                  />
                  <Show when={!nothing()}>{notKept()}</Show>
                </>
              )}
            </QueryView>
          </div>
        }
      >
        {/* The grid stays while a week loads, so going week to week doesn't flash; it says so. */}
        <Show when={events.data === undefined}>
          <Show
            when={events.isError}
            fallback={
              <p role="status" class="sr-only">
                Loading…
              </p>
            }
          >
            <Failed error={events.error} retry={events.refetch} what="your calendar" />
          </Show>
        </Show>
        <Show when={nothing()} fallback={notKept()}>
          {noEvents(true)}
        </Show>
        <div class="min-h-0 flex-1 overflow-auto" aria-busy={events.data === undefined}>
          <Switch>
            <Match when={shown().month}>
              {(month) => (
                <MonthGrid
                  days={shown().days}
                  month={month()}
                  events={drawn()}
                  today={today()}
                  kept={kept}
                  onOpen={onOpen}
                  onDay={(d) => show("day", d)}
                  canMove={moves.can}
                  onMove={moves.drop}
                />
              )}
            </Match>
            <Match when={!shown().month}>
              <TimeGrid
                days={shown().days}
                events={drawn()}
                today={today()}
                kept={kept}
                onOpen={onOpen}
                onDay={(d) => show("day", d)}
                canMove={moves.can}
                onMove={moves.drop}
                over={(d, hour) => <Suggested day={d} hour={hour} finder={finder} />}
              />
            </Match>
          </Switch>
        </div>
      </Show>
      <Show when={popover()}>
        {(p) => <EventPopover event={p().event} at={p().at} pane={props.pane} onClose={close} />}
      </Show>
      <Show when={moves.asking()}>
        {(a) => (
          <MoveConfirm
            question={moveQuestion(a().e, a().to, a().guests)}
            at={a().at}
            onAnswer={moves.answer}
          />
        )}
      </Show>
      <Show when={finder.inviting()}>
        {(i) => (
          <MoveConfirm
            question={i().question}
            detail={i().everyone}
            at={i().at}
            yes="Invite"
            onAnswer={finder.answer}
          />
        )}
      </Show>
    </div>
  );
}
