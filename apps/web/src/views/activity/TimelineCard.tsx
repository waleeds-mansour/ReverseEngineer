// One card of What Pip did: what set Pip off, each action it ran with how far it reaches and how
// it went, the approvals it asked for and your answers, what it did without asking with its Undo
// (the same Undo Today shows), what else it made or changed, the heartbeat items it took up, and
// its reply. Its heading opens the conversation; a record opens itself; an approval still waiting
// opens its card in Updates (lib/inbox.ts).

import { For, Show } from "solid-js";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import { Badge, TextButton } from "../../components/ui.tsx";
import {
  approvalOf,
  isHeld,
  riskOf,
  runOutcome,
  runsOf,
  startedBy,
  type TimelineGroup,
  touchedHow,
} from "../../lib/activity.ts";
import { ago } from "../../lib/format.ts";
import type { PaneRoute } from "../../lib/panes.ts";
import { routeFor } from "../../lib/panes.ts";
import type { Tone } from "../../lib/status.ts";
import { plainReply, turnResult } from "../../lib/turns.ts";
import { UndoAct } from "./UndoAct.tsx";

const SUB = "mt-2 text-meta font-medium text-muted";

function turnTone(status: string): Tone {
  if (status === "failed") return "danger";
  // Still going, or skipped: neither is how it ended well or badly, so neither is a status.
  if (status === "queued" || status === "running" || status === "skipped") return "neutral";
  return "positive";
}

export function TimelineCard(props: {
  group: TimelineGroup;
  go: (route: PaneRoute, beside: boolean) => void;
  /** Opens a waiting approval's card in Updates. */
  answer: (approvalId: string, beside: boolean) => void;
  /** The name of the job its turn ran for, if any (Spec 3). */
  job?: string | undefined;
}) {
  const g = () => props.group;
  const turn = () => g().turn;
  const runs = () => runsOf(g());
  const reply = () => {
    const t = turn();
    return t ? (t.reply ?? t.skipReason ?? t.error) : null;
  };
  // A record with an Undo row opens from there, so it isn't listed twice.
  const touched = () => {
    const undoable = new Set(g().undos.map((u) => u.entityId));
    return g().touched.filter((r) => !undoable.has(r.id));
  };
  const open = (beside: boolean) => {
    const t = turn();
    if (t?.conversationId) props.go({ view: "chat", id: t.conversationId }, beside);
    else if (t?.subjectId) props.go(routeFor("record", t.subjectId), beside);
  };

  return (
    <li class="border-b border-line py-3" data-group={g().id}>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <Show
          when={turn()?.conversationId || turn()?.subjectId}
          fallback={<span class="font-medium">{startedBy(g())}</span>}
        >
          <TextButton alone class="font-medium text-ink" onClick={(e) => open(e.shiftKey)}>
            {startedBy(g())}
          </TextButton>
        </Show>
        <Show when={props.job}>{(job) => <Badge tone="accent">{job()}</Badge>}</Show>
        <Show when={turn()?.mode === "proactive"}>
          <Badge>On its own</Badge>
        </Show>
        <Show when={turn()}>
          {(t) => <Badge tone={turnTone(t().status)}>{turnResult(t())}</Badge>}
        </Show>
        <Show when={turn()?.readOutside}>
          <OutsideMark>Read outside content</OutsideMark>
        </Show>
        <span class="flex-1" />
        <span class="text-xs text-faint tabular-nums">{ago(g().at)}</span>
      </div>
      <Show when={turn()?.asked}>
        {(asked) => <p class="mt-0.5 line-clamp-2 text-sm text-muted">“{asked()}”</p>}
      </Show>
      <Show when={g().setAside.length > 0}>
        <p class={SUB}>Took up</p>
        <ul class="mt-0.5 space-y-0.5 text-sm text-muted">
          <For each={g().setAside}>{(i) => <li class="line-clamp-1">{i.text}</li>}</For>
        </ul>
      </Show>
      <Show when={runs().length > 0}>
        <ul class="mt-2 space-y-1">
          <For each={runs()}>
            {(r) => (
              <li class="flex items-start gap-2 text-sm">
                <span class="min-w-0 flex-1">
                  {r.said}
                  <Show when={r.count > 1}>
                    <span class="text-muted tabular-nums"> ×{r.count}</span>
                  </Show>
                  <Show when={r.whats.length > 0}>
                    <span class="text-muted"> · {r.whats.join(", ")}</span>
                  </Show>
                  <Show when={r.outcome === "error" && r.error}>
                    <span class="block text-meta text-danger">{r.error}</span>
                  </Show>
                  <Show when={r.outcome === "denied" && isHeld(r.error) && r.error}>
                    {(why) => <span class="block text-meta text-muted">{why()}</span>}
                  </Show>
                </span>
                <Badge>{riskOf(r.risk)}</Badge>
                <Badge tone={runOutcome(r).tone}>{runOutcome(r).word}</Badge>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={g().approvals.length > 0}>
        <p class={SUB}>Asked you</p>
        <ul class="mt-0.5 space-y-1">
          <For each={g().approvals}>
            {(a) => (
              <li class="flex flex-wrap items-center gap-2 text-sm">
                <span class="line-clamp-2 min-w-0 flex-1">{a.summary}</span>
                <Show when={a.status === "pending"}>
                  <TextButton alone onClick={(e) => props.answer(a.id, e.shiftKey)}>
                    Answer in Updates
                  </TextButton>
                </Show>
                <Badge tone={approvalOf(a.status).tone}>{approvalOf(a.status).word}</Badge>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={g().undos.length > 0}>
        <p class={SUB}>Without asking</p>
        <ul class="mt-0.5 space-y-1">
          <For each={g().undos}>
            {(u) => (
              <li class="flex flex-wrap items-center gap-2 text-sm">
                <span class="min-w-0 flex-1" classList={{ "text-muted": u.undone }}>
                  <Show when={u.entityId && u.entityType} fallback={u.did}>
                    <TextButton
                      alone
                      class="text-left text-ink"
                      onClick={(e) => props.go(routeFor(u.entityType!, u.entityId!), e.shiftKey)}
                    >
                      {u.did}
                    </TextButton>
                  </Show>
                </span>
                <Show when={u.outside}>
                  <OutsideMark>Outside content</OutsideMark>
                </Show>
                <UndoAct undo={u} />
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={touched().length > 0}>
        <p class={SUB}>Touched</p>
        <ul class="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-sm">
          <For each={touched()}>
            {(r) => (
              <li class="min-w-0">
                <span class="text-muted">{touchedHow(r.how)} </span>
                <Show when={r.how !== "trashed"} fallback={<span>{r.title || "Untitled"}</span>}>
                  <TextButton alone onClick={(e) => props.go(routeFor(r.type, r.id), e.shiftKey)}>
                    {r.title || "Untitled"}
                  </TextButton>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={reply()}>
        {(text) => <p class="mt-2 line-clamp-3 text-sm">{plainReply(text())}</p>}
      </Show>
    </li>
  );
}
