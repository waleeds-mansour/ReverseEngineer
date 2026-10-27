// Today's "What I did": what Pip did since yesterday, in its own words, each with a way to take it
// back. What it made (a task, a note, the brief) is read from the records themselves (jarvis.did),
// so a line is never Pip's own claim about what it did. Everything else it did without asking
// that Undo can put back (what it trashed, a task or memory it changed, your calendar) comes from
// activity.undos, the same list What Pip did shows on its cards: the same Undo, greyed the same
// way once it can't. A line with none says where to change it instead: a drafted reply is in Ready
// to send, and an event Pip added (or its prep) is changed in Calendar for now. Each line
// opens what it's about, and one written after reading outside content says so (D58). Runs that
// stopped before they finished are counted under them, so a failure never goes quiet.

import { For, Show } from "solid-js";
import { Icon, type IconName } from "../../components/icons.tsx";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import type { QueryRead } from "../../components/QueryView.tsx";
import { day, plural, time } from "../../lib/format.ts";
import type { PaneRoute } from "../../lib/panes.ts";
import { routeFor } from "../../lib/panes.ts";
import type { PipDid as Item } from "../../lib/pipFeed.ts";
import type { Did } from "../../lib/types.ts";
import { UndoAct } from "../activity/UndoAct.tsx";
import { CardEmpty, CardWaiting, type Go, TodayCard, TodayRow } from "./parts.tsx";

/** How many the card shows; the rest are in What Pip did. */
const SHOWN = 6;

/** Each kind of thing Pip makes or changes, by the icon of where it lives. */
const KIND: Record<string, IconName> = {
  email_draft: "mail",
  task: "tasks",
  event: "calendar",
  prep: "calendar",
  brief: "today",
  journal: "docs",
  note: "docs",
  canvas: "board",
  person: "people",
  company: "people",
  memory_note: "memory",
  page_watch: "browser",
};

/** Where to change what Pip made that has no Undo here. */
const ELSEWHERE: Record<string, string> = {
  email_draft: "In Ready to send",
  event: "Change it in Calendar",
  prep: "Change it in Calendar",
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
  const when = (iso: string) => {
    const d = new Date(iso);
    const on = day(d, props.now);
    return on === "today" ? time(d) : on === "yesterday" ? "Yesterday" : on;
  };
  const meta = (at: string, outside: boolean | undefined) => (
    <>
      {when(at)}
      <Show when={outside}>
        {" · "}
        <OutsideMark>Read outside content</OutsideMark>
      </Show>
    </>
  );

  const made = (item: Extract<Item, { kind: "made" }>) => {
    const d = item.did;
    return (
      <TodayRow
        quiet={item.undo?.undone}
        lead={<Icon name={KIND[d.entityType] ?? "docs"} class="text-muted" />}
        title={<span class="line-clamp-2">{d.text}</span>}
        meta={meta(d.at, d.outside)}
        end={
          <Show
            when={item.undo}
            fallback={
              <Show when={ELSEWHERE[d.entityType]}>
                {(w) => <span class="shrink-0 text-meta text-faint">{w()}</span>}
              </Show>
            }
          >
            {(u) => <UndoAct undo={u()} />}
          </Show>
        }
        onOpen={(beside) => props.go(props.routeOf(d), beside)}
      />
    );
  };

  const changed = (item: Extract<Item, { kind: "changed" }>) => {
    const u = item.undo;
    const open = (beside: boolean) => {
      if (u.entityId && u.entityType) props.go(routeFor(u.entityType, u.entityId), beside);
      else props.go({ view: "activity" }, beside);
    };
    return (
      <TodayRow
        quiet={u.undone}
        lead={<Icon name={KIND[u.entityType ?? ""] ?? "activity"} class="text-muted" />}
        title={<span class="line-clamp-2">{u.did}</span>}
        meta={meta(u.at, u.outside)}
        end={<UndoAct undo={u} />}
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
