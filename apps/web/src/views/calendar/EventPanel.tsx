// An event's own part of its record (Record.tsx): its prep first, then when, where, who, and
// Google's link.

import { Show } from "solid-js";
import { Body } from "../../components/Body.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import { Button, TextButton } from "../../components/ui.tsx";
import { layout, routeFor } from "../../lib/panes.ts";
import { useAction } from "../../lib/query.ts";
import type { CalEvent, Entity } from "../../lib/types.ts";
import { takeNotes } from "../Meeting.tsx";
import { eventWhen, Guests } from "./parts.tsx";

export function EventPanel(props: { id: string }) {
  const ev = useAction<CalEvent | null>("calendar.get", () => ({ id: props.id }));
  return (
    <Show when={ev.data}>
      {(e) => (
        <>
          <Show when={e().prepId}>{(id) => <Prep id={id()} />}</Show>
          <div class="space-y-1 rounded-md bg-sunk px-3 py-3 text-sm">
            <p class="font-medium">
              {eventWhen(e())}
              {e().status === "cancelled" ? " (cancelled)" : ""}
            </p>
            <Show when={e().location}>
              <p class="text-muted">{e().location}</p>
            </Show>
            <Guests event={e()} />
            <p class="flex gap-3 pt-1">
              <TextButton alone onClick={(ev) => void takeNotes(e().id, ev.shiftKey)}>
                Meeting notes
              </TextButton>
              <Show when={e().meetUrl}>
                {(url) => (
                  <TextButton alone href={url()} target="_blank">
                    Join video call
                  </TextButton>
                )}
              </Show>
              <Show when={e().htmlLink}>
                {(url) => (
                  <TextButton alone href={url()} target="_blank">
                    Open in Google Calendar
                  </TextButton>
                )}
              </Show>
            </p>
          </div>
        </>
      )}
    </Show>
  );
}

/**
 * What Pip gathered for the meeting, at the top of its page, and a way to the packet itself.
 * A packet that quotes what other people wrote says so (D25).
 */
function Prep(props: { id: string }) {
  const rec = useAction<Entity>("entity.get", () => ({ id: props.id }));
  return (
    <Show when={rec.data}>
      {(p) => (
        <section aria-labelledby={`prep-${p().id}`} class="rounded-lg bg-raised p-4 shadow-1">
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <h2 id={`prep-${p().id}`} class="text-heading">
              Prep
            </h2>
            <Show when={p().outside}>
              <OutsideMark>Quotes outside content</OutsideMark>
            </Show>
            <span class="flex-1" />
            <Button
              size="sm"
              onClick={(ev) => layout.open(routeFor(p().type, p().id), { beside: ev.shiftKey })}
            >
              Open
            </Button>
          </div>
          <Body text={p().body} />
        </section>
      )}
    </Show>
  );
}
