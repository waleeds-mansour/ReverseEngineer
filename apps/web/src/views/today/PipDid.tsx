// Today's "What I did": what Pip did since yesterday, in its own words, each with a way to take it
// back. What it made (a task, a note, the brief) is read from the records themselves (jarvis.did),
// so a line is never Pip's own claim about what it did, and its Undo moves it to the trash (the
// toast brings it back). What it changed on your calendar on its own has its own exact Undo (D71,
// D72). A drafted reply has none: it's in Ready to send, to send or change. Each line opens what it's
// about, and one written after reading outside content says so (D58). Runs that stopped before they
// finished are counted under them, so a failure never goes quiet.

import { createSignal, For, Show } from "solid-js";
import { Icon, type IconName } from "../../components/icons.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { Button } from "../../components/ui.tsx";
import { day, plural, time } from "../../lib/format.ts";
import type { PaneRoute } from "../../lib/panes.ts";
import { routeFor } from "../../lib/panes.ts";
import type { PipDid as Item } from "../../lib/pipFeed.ts";
import { moveToTrash, named } from "../../lib/trash.ts";
import type { Did } from "../../lib/types.ts";
import { UndoButton } from "../inbox/UndoButton.tsx";
import { CardEmpty, CardWaiting, type Go, TodayCard, TodayRow } from "./parts.tsx";

/** How many the card shows; the rest are in What Pip did. */
const SHOWN = 6;

/** What it made, without what kind it is: "Call the plumber" from "Made a task: Call the plumber". */
const titleOf = (d: Did) => {
  const at = d.text.indexOf(": ");
  return at > 0 ? d.text.slice(at + 2) : d.text;
};

/** Each kind of thing Pip makes, by the icon of where it lives. */
const KIND: Record<string, IconName> = {
  email_draft: "mail",
  task: "tasks",
  event: "calendar",
  prep: "calendar",
  brief: "today",
  journal: "docs",
  note: "docs",
};

export function PipDid(props: {
  query: QueryRead<unknown>;
  items: readonly Item[];
  /** Runs since yesterday that stopped before they finished. */
  failed: number;
  now: Date;
  go: Go;
  /** Where a made thing opens: a drafted reply in its conversation, anything else as itself. */
  routeOf: (d: Did) => PaneRoute;
}) {
  // What you took back here, so its line says so rather than offering Undo again.
  const [undone, setUndone] = createSignal<ReadonlySet<string>>(new Set());
  const [undoing, setUndoing] = createSignal<string | null>(null);
  const takeBack = async (d: Did) => {
    setUndoing(d.entityId);
    if (await moveToTrash(d.entityId)) setUndone((s) => new Set(s).add(d.entityId));
    setUndoing(null);
  };
  const when = (iso: string) => {
    const d = new Date(iso);
    const on = day(d, props.now);
    return on === "today" ? time(d) : on === "yesterday" ? "Yesterday" : on;
  };

  const made = (item: Extract<Item, { kind: "made" }>) => {
    const d = item.did;
    const gone = () => undone().has(d.entityId);
    return (
      <TodayRow
        quiet={gone()}
        lead={<Icon name={KIND[d.entityType] ?? "docs"} class="text-muted" />}
        title={<span class="line-clamp-2">{d.text}</span>}
        meta={
          <>
            {gone() ? "Moved to the trash · " : ""}
            {when(d.at)}
            <Show when={d.outside}>
              {" · "}
              <OutsideMark>Read outside content</OutsideMark>
            </Show>
          </>
        }
        end={
          <Show when={item.undo && !gone()}>
            <span onClick={(e) => e.stopPropagation()}>
              <Button
                size="sm"
                icon="undo-2"
                label={`Undo: move ${named(titleOf(d))} to the trash`}
                disabled={undoing() === d.entityId}
                onClick={() => void takeBack(d)}
              >
                Undo
              </Button>
            </span>
          </Show>
        }
        onOpen={gone() ? undefined : (beside) => props.go(props.routeOf(d), beside)}
      />
    );
  };

  const changed = (item: Extract<Item, { kind: "changed" }>) => {
    const r = item.row;
    const open = (beside: boolean) => {
      if (r.notification.entityId && r.entityType)
        props.go(routeFor(r.entityType, r.notification.entityId), beside);
      else props.go({ view: "inbox" }, beside);
    };
    return (
      <TodayRow
        lead={<Icon name="calendar" class="text-muted" />}
        title={<span class="line-clamp-2">{r.notification.title}</span>}
        meta={when(item.at)}
        below={<UndoButton row={r} />}
        onOpen={open}
      />
    );
  };

  return (
    <TodayCard
      product="jarvis"
      icon="mark"
      title="What I did"
      count={props.items.length}
      more={{ run: () => props.go({ view: "activity" }) }}
      jump="today-did"
    >
      <Show
        when={props.query.data !== undefined}
        fallback={<CardWaiting query={props.query} what="what Pip did" />}
      >
        <Show
          when={props.items.length > 0 || props.failed > 0}
          fallback={
            <CardEmpty>Nothing since yesterday. What I do for you shows up here.</CardEmpty>
          }
        >
          <ul>
            <For each={props.items.slice(0, SHOWN)}>
              {(item) => (item.kind === "made" ? made(item) : changed(item))}
            </For>
            <Show when={props.failed > 0}>
              <TodayRow
                lead={<Icon name="bad" class="text-bad" />}
                title={`${plural(props.failed, "run")} didn't finish`}
                meta="See what happened"
                onOpen={(beside) => props.go({ view: "activity" }, beside)}
              />
            </Show>
          </ul>
        </Show>
      </Show>
    </TodayCard>
  );
}
