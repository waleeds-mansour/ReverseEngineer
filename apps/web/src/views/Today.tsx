// Today: Pip's feed of your day. At the top Pip says how the day looks, a sentence a thing, each
// taking you to its part, with what you start most under it. Down the middle, what needs you: every
// approval waiting for your yes, the drafts Pip has ready to send, who's waiting on a reply, the
// brief, what's new from Pip, and what Pip did since yesterday, each with its Undo. Beside that on
// a wide pane (under it on a phone, with the meeting on now or next under the greeting), your day:
// what Pip is working on, your meetings and what's due. It's made only of reads the other screens
// make already, so it refreshes with them. What a row opens goes beside Today, as from any list,
// so Today stays where it was. Its text is 15 px, a step up from the lists: it's read, not scanned.
// Asking Pip is its bar at the bottom of the screen.

import { createMemo, createSignal, For, onMount, Show, useContext } from "solid-js";
import { HomeScreenSteps } from "../components/HomeScreenSteps.tsx";
import { Card } from "../components/kit/Card.tsx";
import { SectionHeader } from "../components/kit/SectionHeader.tsx";
import { JarvisMark } from "../components/Mark.tsx";
import { SetupChecklist } from "../components/SetupChecklist.tsx";
import { Button, Failed, PaneContext, PaneHeader } from "../components/ui.tsx";
import { createToday, timeNow } from "../lib/clock.ts";
import type { Desk } from "../lib/desk.ts";
import { time } from "../lib/format.ts";
import { askedToSend } from "../lib/needsYou.ts";
import { layout, type PaneRoute, routeFor } from "../lib/panes.ts";
import { dayLooks, newFromPip, pipDid, pipLine } from "../lib/pipFeed.ts";
import type { UndoView } from "../lib/pipUndo.ts";
import { usePush } from "../lib/push.ts";
import { inboxInput, useAction, usePendingApprovals } from "../lib/query.ts";
import {
  dayPlan,
  greeting,
  jarvisDrafts,
  owed,
  sinceYesterday,
  splitDue,
  startOfYesterday,
} from "../lib/today.ts";
import type { CalEvent, Did, InboxRow, MailDraft, MailThread, Task, Turn } from "../lib/types.ts";
import { openToReply } from "./Mail.tsx";
import { Brief } from "./today/Brief.tsx";
import { Due } from "./today/Due.tsx";
import { FromPip } from "./today/FromPip.tsx";
import {
  ApproveAllSaid,
  Clear,
  NeedsYou,
  NeedsYouWaiting,
  useApproveAll,
} from "./today/NeedsYou.tsx";
import { PipDid } from "./today/PipDid.tsx";
import { PipWorking } from "./today/PipWorking.tsx";
import { ReadyToSend } from "./today/ReadyToSend.tsx";
import { Replies } from "./today/Replies.tsx";
import { Starters } from "./today/Starters.tsx";
import { UpNext, YourDay } from "./today/YourDay.tsx";

const DAY = 86_400_000;

export function Today(props: { pane: number }) {
  const pane = useContext(PaneContext);
  // The clock moves the meetings on with every other row (lib/clock.ts), and a new day brings a
  // new day's reads.
  const now = createMemo(() => timeNow());
  const dayStart = createToday();

  const approvals = usePendingApprovals();
  const inbox = useAction<InboxRow[]>("inbox.list", () => inboxInput("live", "signal"));
  const drafts = useAction<MailDraft[]>("mail.drafts");
  // Today, and the two weeks after it for invitations still to answer.
  const events = useAction<CalEvent[]>("calendar.events", () => ({
    from: new Date(dayStart()).toISOString(),
    to: new Date(dayStart() + 15 * DAY).toISOString(),
  }));
  const tasks = useAction<Task[]>("task.list", () => ({
    dueBefore: new Date(dayStart() + DAY - 1).toISOString(),
    limit: 100,
  }));
  // Enough of them to leave out the ones with a reply drafted and still have five.
  const replies = useAction<MailThread[]>("mail.threads", () => ({
    view: "inbox",
    waiting: "you",
    limit: 50,
  }));
  const counts = useAction<{ unread: number; toReply: number }>("mail.counts");
  // What Pip made since yesterday and what else it did without asking, with the Undo What Pip
  // did shows for each; and its runs, for the ones that didn't finish.
  const since = createMemo(() => startOfYesterday(new Date(dayStart())));
  const made = useAction<Did[]>("jarvis.did", () => ({ since: since().toISOString(), limit: 50 }));
  const undos = useAction<UndoView[]>("activity.undos", () => ({ since: since().toISOString() }));
  const turns = useAction<Turn[]>("jarvis.activity", () => ({ limit: 100 }));
  // What Pip is on now, and what's waiting. Read again every half minute while there's something,
  // since a turn that ends outside a conversation says nothing live.
  const desk = useAction<Desk>(
    "jarvis.desk",
    () => ({}),
    () => true,
    (d) => (d && (d.running.length > 0 || d.waitingCount > 0) ? 30_000 : false),
  );
  const busy = () => (desk.data?.running.length ?? 0) + (desk.data?.waitingCount ?? 0) > 0;
  const push = usePush();
  // On an iPhone in Safari, Turn on notifications shows the step that makes them possible.
  const [homeScreenSteps, showHomeScreenSteps] = createSignal(false);
  const approving = useApproveAll();
  // What was waiting when Today first heard: Needs you's first showing is what Today opened on
  // only if it's those. If Today opened with nothing waiting, what shows later has only just come,
  // and Approve all waits a moment before covering it. Asking counts as showing it.
  const openedOn = createMemo<ReadonlySet<string> | null>(
    (prev) => prev ?? (approvals.data ? new Set(approvals.data.map((a) => a.id)) : null),
    null,
  );
  let shownOnce = false;
  const opening = () => {
    const on = openedOn();
    const first = !shownOnce && on !== null && pending().every((a) => on.has(a.id));
    shownOnce = true;
    return first;
  };

  // Send sends what's shown, so the drafts are read again on arrival, and Send waits for that.
  const opened = Date.now();
  onMount(() => void drafts.refetch());
  const fresh = () => !drafts.isFetching && drafts.dataUpdatedAt >= opened;

  const pending = () => approvals.data ?? [];
  const mine = createMemo(() => jarvisDrafts(drafts.data));
  // A draft Pip already asked to send waits in Needs you, so it isn't offered here as well.
  const ready = createMemo(() => {
    const asked = askedToSend(approvals.data);
    return mine().filter((d) => !asked.has(d.id));
  });
  const readyIds = createMemo(() => new Set(ready().map((d) => d.id)));
  const plan = createMemo(() => dayPlan(events.data, now()));
  const due = createMemo(() => splitDue(tasks.data, now()));
  const failed = createMemo(
    () => sinceYesterday(turns.data, now()).filter((t) => t.status === "failed").length,
  );
  // A drafted reply opens in its conversation, where it's written; anything else as itself.
  const routeOf = (d: Did): PaneRoute => {
    const thread = drafts.data?.find((x) => x.id === d.entityId)?.threadId;
    return thread ? { view: "thread", id: thread } : routeFor(d.entityType, d.entityId);
  };
  const brief = () => inbox.data?.find((r) => r.notification.kind === "brief");
  // Conversations with a reply Pip drafted: it's on Today already, ready or asking.
  const owing = createMemo(() =>
    owed(replies.data, new Set(mine().flatMap((d) => (d.threadId ? [d.threadId] : [])))),
  );
  const fromPip = createMemo(() => newFromPip(inbox.data));
  const did = createMemo(() => pipDid(made.data, undos.data));
  const meetings = () => plan().today.filter((e) => !e.allDay);
  const dueCount = () => due().overdue.length + due().today.length;
  const said = () =>
    pipLine({
      approvals: approvals.data ? pending().length : null,
      ready: drafts.data ? ready().length : null,
      meetings: meetings(),
      owed: replies.data ? replies.data.length - owing().drafted : 0,
      due: dueCount(),
      now: now(),
    });
  const looks = () =>
    dayLooks(
      { meetings: meetings().length, due: dueCount(), waiting: pending().length + ready().length },
      now(),
    );
  const clear = () =>
    approvals.data !== undefined &&
    pending().length === 0 &&
    drafts.data !== undefined &&
    ready().length === 0 &&
    !approving.result();

  // Beside Today, as from any list (on a phone, over it, and closing goes back); shift for a new pane.
  const go = (route: PaneRoute, beside = false) => {
    if (beside) layout.open(route, { beside: true });
    else layout.show(route, props.pane);
  };
  let root: HTMLDivElement | undefined;
  const jump = (to: string) =>
    root
      ?.querySelector(`[data-jump="${to}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    // Today's 15 px: every text-sm inside it reads one step larger.
    <div
      class="flex h-full flex-col [--text-sm--line-height:1.375rem] [--text-sm:0.9375rem]"
      data-product="today"
    >
      {/* Beside another pane it needs its close button; on its own, Pip's greeting heads it. */}
      <Show when={pane.close} fallback={<h1 class="sr-only">Today</h1>}>
        <PaneHeader title="Today" />
      </Show>
      <div ref={root} class="@container flex-1 overflow-auto bg-bg">
        <div class="mx-auto max-w-[71rem] px-4 pt-6 pb-12 md:px-10 md:pt-9">
          <header class="flex flex-wrap items-start gap-x-5 gap-y-3">
            <JarvisMark size={40} class="mt-1 max-md:hidden" />
            {/* On a phone the button goes under the words, rather than squeezing them. */}
            <div class="min-w-0 flex-1 basis-80">
              <p class="text-overline text-muted uppercase">
                {now().toLocaleDateString("en-US", {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}
                {` · ${time(now())}`}
              </p>
              <h2 class="mt-1.5 text-title-1">
                {greeting(now())}. {looks()}
              </h2>
              {/* Each sentence takes you to what it's about. Kept by its words: the minute moving
                  on doesn't draw it again, and the focus stays on it. */}
              <p class="mt-2 max-w-3xl text-[1.0625rem]/[1.625rem] text-muted">
                <For each={said().map((s) => s.text)}>
                  {(text) => (
                    <>
                      <button
                        type="button"
                        class="rounded-sm text-left underline-offset-2 hover:text-ink hover:underline"
                        onClick={() => {
                          const to = said().find((s) => s.text === text)?.to;
                          if (to) jump(to);
                        }}
                      >
                        {text}
                      </button>{" "}
                    </>
                  )}
                </For>
              </p>
              <Starters go={go} class="mt-4" />
            </div>
            <Show when={push.canTurnOn() || (push.needsHomeScreen && !homeScreenSteps())}>
              <Button
                icon="bell"
                disabled={push.busy()}
                onClick={() =>
                  push.needsHomeScreen ? showHomeScreenSteps(true) : void push.turnOn()
                }
              >
                Turn on notifications
              </Button>
            </Show>
          </header>
          <Show when={homeScreenSteps()}>
            <HomeScreenSteps class="mt-4 max-w-xl" />
          </Show>
          {/* Hearth opens here, so what's still to connect shows here first. */}
          <SetupChecklist pane={props.pane} class="mt-6" />
          <UpNext today={plan().today} now={now()} go={go} class="mt-5 @4xl:hidden" />
          <div class="mt-8 grid gap-x-11 gap-y-8 @4xl:grid-cols-[minmax(0,1fr)_21rem] @4xl:items-start">
            <div class="flex min-w-0 flex-col gap-8">
              {/* What Approve all said stays over Needs you, even once its cards have gone. */}
              <Show
                when={
                  approving.result() || approvals.data === undefined || pending().length || clear()
                }
              >
                <div class="space-y-3">
                  <ApproveAllSaid approving={approving} ready={readyIds()} />
                  <Show
                    when={approvals.data !== undefined}
                    fallback={<NeedsYouWaiting query={approvals} />}
                  >
                    <Show
                      when={pending().length > 0}
                      fallback={
                        <Show when={clear()}>
                          <Clear />
                        </Show>
                      }
                    >
                      <NeedsYou
                        approvals={pending()}
                        inbox={inbox.data}
                        drafts={drafts.data}
                        approving={approving}
                        opening={opening}
                        go={go}
                      />
                    </Show>
                  </Show>
                </div>
              </Show>
              <Show when={drafts.data === undefined && drafts.isError}>
                <section aria-labelledby="today-drafts" class="space-y-3">
                  <SectionHeader id="today-drafts" title="Ready to send" />
                  <Card flush>
                    <Failed error={drafts.error} retry={drafts.refetch} what="Pip's drafts" />
                  </Card>
                </section>
              </Show>
              <Show when={ready().length > 0}>
                <ReadyToSend drafts={ready()} fresh={fresh()} go={go} />
              </Show>
              <Replies
                query={replies}
                threads={owing().rows}
                total={counts.data?.toReply ?? replies.data?.length ?? 0}
                drafted={owing().drafted}
                go={go}
                all={() => openToReply(props.pane)}
                toDrafts={() => jump(ready().length ? "today-drafts" : "today-needs")}
              />
              {/* Each new brief is drawn afresh (keyed), so yesterday's being read doesn't make
                  today's read. */}
              <Show when={brief()?.notification.id} keyed>
                {(_id) => <Brief row={brief()!} go={go} />}
              </Show>
              <Show when={fromPip().rows.length > 0}>
                <FromPip rows={fromPip().rows} more={fromPip().more} go={go} />
              </Show>
              <PipDid
                query={made}
                items={did()}
                failed={failed()}
                now={now()}
                go={go}
                routeOf={routeOf}
              />
            </div>
            <div class="min-w-0 space-y-4">
              <Show when={busy()}>
                <PipWorking desk={desk.data!} now={now()} go={go} />
              </Show>
              <YourDay
                query={events}
                today={plan().today}
                invites={plan().invites}
                now={now()}
                go={go}
              />
              <Due query={tasks} overdue={due().overdue} today={due().today} now={now()} go={go} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
