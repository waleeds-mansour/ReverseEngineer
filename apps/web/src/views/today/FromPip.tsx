// Today's "New from me": what Pip told you that you haven't seen yet (lib/pipFeed.ts newFromPip),
// a few lines of it: what it noticed, what it wants you to know, the question it has. Each opens
// what it's about (or Updates, where the note is) and counts as seen; Done puts it away. The rest
// are in Updates.

import { For, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { Button } from "../../components/ui.tsx";
import { ago } from "../../lib/format.ts";
import { routeFor } from "../../lib/panes.ts";
import { act } from "../../lib/query.ts";
import type { InboxRow } from "../../lib/types.ts";
import { type Go, TodayCard, TodayRow } from "./parts.tsx";

export function FromPip(props: { rows: readonly InboxRow[]; more: number; go: Go }) {
  const mark = (r: InboxRow, state: "seen" | "done") =>
    void act("inbox.mark", { ids: [r.notification.id], state });
  const open = (r: InboxRow, beside: boolean) => {
    mark(r, "seen");
    const n = r.notification;
    if (n.entityId && r.entityType) props.go(routeFor(r.entityType, n.entityId), beside);
    else props.go({ view: "inbox" }, beside);
  };
  return (
    <TodayCard
      product="jarvis"
      icon="mark"
      title="New from me"
      count={props.rows.length + props.more}
      more={{ label: "Updates", run: () => props.go({ view: "inbox" }) }}
    >
      <ul>
        <For each={props.rows}>
          {(r) => (
            <TodayRow
              lead={<Icon name="inbox" class="text-muted" />}
              title={<span class="line-clamp-2">{r.notification.title}</span>}
              meta={r.notification.body?.split("\n")[0] || ago(r.notification.createdAt)}
              end={
                <span onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="quiet" onClick={() => mark(r, "done")}>
                    Done
                  </Button>
                </span>
              }
              onOpen={(beside) => open(r, beside)}
            />
          )}
        </For>
      </ul>
      <Show when={props.more > 0}>
        <p class="border-t border-line px-4 py-2 text-meta text-muted">
          {props.more} more in Updates
        </p>
      </Show>
    </TodayCard>
  );
}
