// What Pip has been doing: one card for each thing that set it off (your ask, a routine, something
// it noticed), with every action it ran, the approvals it asked for and how they went, what it
// touched and its reply (activity.timeline, activity/TimelineCard.tsx). Above them, what it's
// watching for you, what's waiting for its next check, and what it noted for your next brief. The
// Slack filter shows only what Slack started, and Pip's conversations there (D62).

import { createMemo, createSignal, For, Show } from "solid-js";
import { NoRows } from "../components/QueryView.tsx";
import { Badge, Button, PaneHeader } from "../components/ui.tsx";
import { fromSlack, type Timeline } from "../lib/activity.ts";
import { showApproval } from "../lib/inbox.ts";
import { layout, type PaneRoute } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import type { Observation, Watch } from "../lib/types.ts";
import { TimelineCard } from "./activity/TimelineCard.tsx";
import { SlackConversations } from "./SlackConversations.tsx";

/** Turns per page, and the most the timeline reads at once. */
const PAGE = 30;
const MOST = 100;
/**
 * A reflex's own action says nothing live that this listens to (lib/invalidate.ts), so the
 * timeline is read again now and then while it's open.
 */
const POLL_MS = 60_000;

const HEADING = "mb-2 text-xs font-medium uppercase tracking-wide text-faint";

export function Activity() {
  const [limit, setLimit] = createSignal(PAGE);
  const timeline = useAction<Timeline>(
    "activity.timeline",
    () => ({ limit: limit() }),
    () => true,
    () => POLL_MS,
  );
  // Show older reads a longer page: the shorter one stays up until it's in.
  const data = createMemo<Timeline | undefined>((prev) => timeline.data ?? prev);
  const watches = useAction<Watch[]>("jarvis.watches");
  const notes = useAction<Observation[]>("observation.list", () => ({ limit: 50 }));
  const [slackOnly, setSlackOnly] = createSignal(false);
  const shown = () => (data()?.groups ?? []).filter((g) => !slackOnly() || fromSlack(g));
  const waiting = () => (slackOnly() ? [] : (data()?.waiting ?? []));

  const go = (route: PaneRoute, beside: boolean) => layout.open(route, { beside });
  const answer = (approvalId: string, beside: boolean) => {
    showApproval(approvalId);
    layout.open({ view: "inbox" }, { beside });
  };

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="What Pip did" sub="Everything Pip did, and why" />
      <div class="flex-1 space-y-6 overflow-auto px-4 py-4">
        <div class="flex gap-1">
          <Button
            size="sm"
            variant={slackOnly() ? "secondary" : "primary"}
            onClick={() => setSlackOnly(false)}
          >
            Everything
          </Button>
          <Button
            size="sm"
            variant={slackOnly() ? "primary" : "secondary"}
            onClick={() => setSlackOnly(true)}
          >
            Slack
          </Button>
        </div>
        <Show when={slackOnly()}>
          <SlackConversations />
        </Show>
        <Show when={(watches.data ?? []).length > 0}>
          <section>
            <h3 class={HEADING}>Watching for you</h3>
            <ul class="space-y-1">
              <For each={watches.data}>
                {(w) => (
                  <li class="flex items-center gap-3 rounded-md bg-sunk px-3 py-2">
                    <span class="flex-1">{w.description}</span>
                    <Show when={w.expiresAt}>
                      <span class="text-xs text-faint">
                        until {new Date(w.expiresAt!).toLocaleDateString()}
                      </span>
                    </Show>
                    <Button size="sm" onClick={() => void act("jarvis.unwatch", { id: w.id })}>
                      Stop
                    </Button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={waiting().length > 0}>
          <section>
            <h3 class={HEADING}>Waiting for Pip's next check</h3>
            <ul class="space-y-1 text-sm">
              <For each={waiting()}>{(i) => <li class="line-clamp-2">{i.text}</li>}</For>
            </ul>
          </section>
        </Show>
        <Show when={(notes.data ?? []).length > 0 && !slackOnly()}>
          <section>
            <h3 class={HEADING}>Noted for your next brief</h3>
            <ul class="space-y-1 text-sm">
              <For each={notes.data}>
                {(o) => (
                  <li class="flex gap-2">
                    <Badge tone={o.kind === "risk" ? "warning" : "neutral"}>{o.kind}</Badge>
                    <span>{o.text}</span>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <section>
          <h3 class={HEADING}>Latest</h3>
          <Show
            when={shown().length > 0}
            fallback={
              <NoRows query={timeline} what="what Pip did">
                {slackOnly()
                  ? "Nothing from Slack in what Pip did lately."
                  : "Pip hasn't done anything yet."}
              </NoRows>
            }
          >
            <ul class="border-t border-line">
              <For each={shown()}>{(g) => <TimelineCard group={g} go={go} answer={answer} />}</For>
            </ul>
            <Show when={data()?.next && limit() < MOST}>
              <div class="pt-3">
                <Button
                  size="sm"
                  disabled={timeline.isFetching}
                  onClick={() => setLimit((n) => Math.min(MOST, n + PAGE))}
                >
                  Show older
                </Button>
              </div>
            </Show>
          </Show>
        </section>
      </div>
    </div>
  );
}
