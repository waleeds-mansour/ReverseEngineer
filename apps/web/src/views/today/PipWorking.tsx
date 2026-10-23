// Today's "Pip is working on": the turn Pip is on now, how long it has been going and until when it
// has, with Stop (jarvis.cancel_turn); then what's waiting after it, in the order Pip takes them
// (jarvis.desk). It's only on Today while Pip has something on, so an idle Pip takes no room.

import { For, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { JarvisMark } from "../../components/Mark.tsx";
import { Button } from "../../components/ui.tsx";
import { type Desk, type DeskTurn, deskTitle, runningLine, waitingLine } from "../../lib/desk.ts";
import { routeFor } from "../../lib/panes.ts";
import { act } from "../../lib/query.ts";
import { type Go, TodayCard, TodayRow } from "./parts.tsx";

export function PipWorking(props: { desk: Desk; now: Date; go: Go }) {
  // A turn opens its conversation, or the record it's about.
  const open = (t: DeskTurn) => {
    const to = t.conversationId
      ? { view: "chat" as const, id: t.conversationId }
      : t.subjectId
        ? routeFor("record", t.subjectId)
        : null;
    return to ? (beside: boolean) => props.go(to, beside) : undefined;
  };
  const more = () => props.desk.waitingCount - props.desk.waiting.length;
  return (
    <TodayCard
      product="jarvis"
      icon="mark"
      title="Pip is working on"
      count={props.desk.running.length + props.desk.waitingCount}
      more={{ run: () => props.go({ view: "activity" }) }}
    >
      <ul>
        <For each={props.desk.running}>
          {(t) => (
            <TodayRow
              lead={<JarvisMark size={14} state={t.stopping ? "idle" : "thinking"} class="mx-px" />}
              title={<span class="line-clamp-2">{deskTitle(t)}</span>}
              meta={runningLine(t, props.now)}
              end={
                <Show when={!t.stopping}>
                  <Button
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void act("jarvis.cancel_turn", { turnId: t.id });
                    }}
                  >
                    Stop
                  </Button>
                </Show>
              }
              onOpen={open(t)}
            />
          )}
        </For>
        <For each={props.desk.waiting}>
          {(t) => (
            <TodayRow
              quiet
              lead={<Icon name="snooze" />}
              title={<span class="line-clamp-2">{deskTitle(t)}</span>}
              meta={waitingLine(t, props.now)}
              onOpen={open(t)}
            />
          )}
        </For>
        <Show when={more() > 0}>
          <TodayRow
            quiet
            title={`${more()} more waiting`}
            onOpen={(beside) => props.go({ view: "activity" }, beside)}
          />
        </Show>
      </ul>
    </TodayCard>
  );
}
