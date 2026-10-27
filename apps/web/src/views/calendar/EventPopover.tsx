// An event's popover, beside it on Calendar's grid: when and where, who's coming and their
// answers, yours to give if it's an invitation, its prep and meeting notes, Join, and Pip's mark on
// one Pip put there. Escape, a click elsewhere or a scroll closes it; Open shows the event's page.
// One time of a repeating event says a drag moves that time only.

import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { InviteAnswers } from "../../components/InviteAnswers.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { Badge, Button, IconButton, TextButton } from "../../components/ui.tsx";
import { canDrag } from "../../lib/calDrag.ts";
import { popoverAt } from "../../lib/calLayout.ts";
import { layout } from "../../lib/panes.ts";
import type { CalEvent } from "../../lib/types.ts";
import { takeNotes } from "../Meeting.tsx";
import { evColour, eventWhen, Guests } from "./parts.tsx";

/** An invitation to you, on a calendar of yours: your answer is yours to give or change. */
const yoursToAnswer = (e: CalEvent) =>
  e.ownCalendar && !e.selfOrganizer && e.selfResponse !== null && e.status !== "cancelled";

export function EventPopover(props: {
  event: CalEvent;
  /** Where the event is on screen. */
  at: DOMRect;
  pane: number;
  /** Closes it; `refocus` puts the focus back on the event, as after Escape. */
  onClose: (refocus: boolean) => void;
}) {
  let box!: HTMLDivElement;
  const id = createUniqueId();
  const [where, setWhere] = createSignal<{ top: number; left: number }>();
  const e = () => props.event;
  // The whole event, or its notes, beside Calendar, as its rows always opened.
  // Read before closing: once closed, the event it was opened for is gone from it.
  const open = () => {
    const at = { id: e().id, pane: props.pane };
    props.onClose(false);
    layout.open({ view: "record", id: at.id }, { beside: true, pane: at.pane });
  };
  const notes = () => {
    const at = e().id;
    props.onClose(false);
    void takeNotes(at, true);
  };

  onMount(() => {
    const size = { width: box.offsetWidth, height: box.offsetHeight };
    setWhere(popoverAt(props.at, size, { width: window.innerWidth, height: window.innerHeight }));
    box.focus({ preventScroll: true });
    const away = (ev: Event) => {
      if (!box.contains(ev.target as Node)) props.onClose(false);
    };
    const gone = () => props.onClose(false);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", gone);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", gone);
    });
  });

  return (
    <Portal>
      <div
        ref={box}
        role="dialog"
        aria-labelledby={id}
        tabindex="-1"
        data-product="calendar"
        class="glass-strong fixed z-(--z-popup) w-80 max-w-[calc(100vw-1rem)] rounded-lg p-4 text-sm shadow-4"
        // Drawn unseen first, to measure it, then put beside its event.
        style={(() => {
          const at = where();
          return at
            ? { top: `${at.top}px`, left: `${at.left}px` }
            : { top: "0px", left: "0px", visibility: "hidden" };
        })()}
        onKeyDown={(ev) => {
          // Keys pressed here are the popover's, not Calendar's behind it (t, d, w, m, arrows).
          if (!ev.ctrlKey && !ev.metaKey) ev.stopPropagation();
          if (ev.key === "Escape") {
            ev.preventDefault();
            props.onClose(true);
          }
        }}
      >
        <div class="flex items-start gap-2.5">
          <span
            aria-hidden="true"
            class="mt-1.5 size-2.5 shrink-0 rounded-full bg-[var(--ev)]"
            style={evColour(e())}
          />
          <h2
            id={id}
            class={`min-w-0 flex-1 text-heading break-words ${e().selfResponse === "declined" ? "line-through" : ""}`}
          >
            {e().title}
          </h2>
          <IconButton
            icon="x"
            label="Close"
            class="-mt-1 -mr-2"
            onClick={() => props.onClose(true)}
          />
        </div>
        <Show when={e().madeByPip}>
          <p class="mt-1 flex items-center gap-1.5 text-meta text-jarvis">
            <JarvisMark size={12} />
            Pip put this on your calendar
          </p>
        </Show>
        <div class="mt-2 space-y-1">
          <p>
            {eventWhen(e())}
            {e().status === "cancelled" ? " (cancelled)" : ""}
          </p>
          <Show when={e().location}>
            <p class="break-words text-muted">{e().location}</p>
          </Show>
          <Guests event={e()} />
          <Show when={e().recurringEventId && canDrag(e())}>
            <p class="text-meta text-muted">Dragging it moves this time only.</p>
          </Show>
        </div>
        <Show when={e().taskId || e().prepId || e().canWrite === false}>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <Show when={e().taskId}>
              <Badge icon="tasks">Focus block</Badge>
            </Show>
            <Show when={e().prepId}>
              <Badge tone="positive" onClick={open} title="Open the event with its prep">
                Prep ready
              </Badge>
            </Show>
            <Show when={e().canWrite === false}>
              <Badge icon="lock" title="It's on a calendar you can only read">
                Read only
              </Badge>
            </Show>
          </div>
        </Show>
        <Show when={yoursToAnswer(e())}>
          <InviteAnswers
            eventId={e().id}
            response={e().selfResponse}
            recurring={e().recurringEventId !== null}
            class="mt-3"
          />
        </Show>
        <div class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Show when={e().meetUrl}>
            {(url) => (
              <Button href={url()} target="_blank" icon="video" size="sm" variant="primary">
                Join
              </Button>
            )}
          </Show>
          <TextButton alone onClick={notes}>
            Meeting notes
          </TextButton>
          <TextButton alone onClick={open}>
            Open
          </TextButton>
        </div>
      </div>
    </Portal>
  );
}
