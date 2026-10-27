// Mail: every account's conversations in one list, plus what needs your reply and what you're
// waiting on. The inbox reads like a person's: People's newest conversations first, then one row
// for each other bundle (Updates, Receipts, Newsletters) with how many and who from, which opens
// to its conversations (Esc goes back). Its keys are in mail/keys.ts: j/k go on from the
// conversations into the bundle rows. Pointing at a row shows Archive, Make task and Reply; its
// menu moves it to another bundle. Changes show at once and reach Gmail within a minute. Older
// conversations load as you scroll down to them. One with a reply drafted says so, and whether
// Pip wrote it.

import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Skeleton } from "../components/kit/Skeleton.tsx";
import { Button, Empty, PaneHeader } from "../components/ui.tsx";
import { debounced } from "../lib/debounce.ts";
import { useHotkeys } from "../lib/hotkeys.ts";
import { toast } from "../lib/live.ts";
import { archive, listClosed, makeTask, openedFrom, reply } from "../lib/mailActions.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { createSelection } from "../lib/selection.ts";
import type {
  BundledThread,
  MailAccount,
  MailBundle,
  MailBundleCount,
  MailDraft,
} from "../lib/types.ts";
import { Composer } from "./MailCompose.tsx";
import { FIRST, PAGE, useThreadPages, whenSeen } from "./MailPages.ts";
import { MailSyncBanner } from "./MailSyncStatus.tsx";
import {
  BundleHeader,
  BundleRows,
  BundlesUnknown,
  folded,
  MorePeople,
  PeopleHeader,
} from "./mail/Bundles.tsx";
import { mailKeys } from "./mail/keys.ts";
import { ThreadRow } from "./mail/ThreadRow.tsx";

export { named } from "./mail/ThreadRow.tsx";

type View = "inbox" | "starred" | "sent" | "all" | "trash";

type Lane = "inbox" | "reply" | "waiting";
/** A lane Mail was asked to open on from elsewhere, and in which pane, until that pane does. */
const [asked, setAsked] = createSignal<{ lane: Lane; pane: number } | null>(null);

/**
 * Opens Mail beside pane `from` on the conversations that need your reply (Today's "All" under
 * Replies you owe). Only that Mail pane turns to them; any other Mail pane stays as it is.
 */
export function openToReply(from: number) {
  layout.show({ view: "mail" }, from);
  // Where show put it: the pane to the right, or the last one when there's no room for another.
  setAsked({ lane: "reply", pane: Math.min(from + 1, layout.panes().length - 1) });
}

export function Mail(props: { pane: number }) {
  const [view, setView] = createSignal<View>("inbox");
  // Asked before this pane was drawn: it opens on that lane.
  const mine = untrack(() => {
    const a = asked();
    return a?.pane === props.pane ? a : null;
  });
  if (mine) setAsked(null);
  const [lane, setLane] = createSignal<Lane>(mine?.lane ?? "inbox");
  // The bundle opened from the inbox's rows; none is the inbox in bundles.
  const [bundle, setBundle] = createSignal<MailBundle | null>(null);
  const [query, setQuery] = createSignal("");
  const accounts = useAction<MailAccount[]>("mail.accounts");
  // What's searched for: what's typed, once typing pauses.
  const term = debounced(query);
  const searching = () => term().trim().length > 0;
  const inbox = () => view() === "inbox" && lane() === "inbox" && !searching();
  /** The inbox in bundles: People's newest, then a row for each other bundle. */
  const bundled = () => inbox() && bundle() === null;
  const counts = useAction<MailBundleCount[]>("mail.bundles", () => ({}), inbox);
  const countOf = (b: MailBundle) => counts.data?.find((c) => c.bundle === b)?.count ?? 0;
  // The bundle rows under People, and which of them the keyboard is on (none: a conversation).
  const rows = () => (bundled() ? folded(counts.data ?? []) : []);
  const [onRow, setOnRow] = createSignal<number | null>(null);
  createEffect(() => {
    const n = rows().length;
    const at = untrack(onRow);
    if (at !== null && at >= n) setOnRow(n > 0 ? n - 1 : null);
  });
  const listed = useThreadPages(
    () => {
      if (view() !== "inbox") return { view: view(), limit: PAGE };
      if (lane() === "reply") return { view: "inbox", waiting: "you", limit: 100 };
      if (lane() === "waiting") return { view: "all", waiting: "them", limit: 100 };
      const b = bundle();
      return b
        ? { view: "inbox", bundle: b, limit: PAGE }
        : { view: "inbox", bundle: "people", limit: FIRST };
    },
    () => !searching(),
  );
  const found = useAction<BundledThread[]>(
    "mail.search",
    () => ({ query: term().trim() }),
    searching,
  );
  const threads = {
    get data() {
      return searching() ? found.data : listed.list();
    },
    get isLoading() {
      return searching() ? found.isLoading : listed.query.isLoading;
    },
  };
  const list = () => threads.data ?? [];
  const paging = () => !searching() && listed.query.hasNextPage;
  // Nothing at all to show: no conversation listed, and in bundles, none in any other bundle.
  const nothing = () =>
    list().length === 0 && (!bundled() || counts.data?.every((c) => c.count === 0) === true);
  const drafts = useAction<MailDraft[]>("mail.drafts");
  // New messages (not replies) are written here, above the list.
  const fresh = () => (drafts.data ?? []).filter((d) => !d.threadId).map((d) => d.id);
  // Conversations with a reply waiting to go, and who wrote the newest one.
  const drafted = createMemo(() => {
    const by = new Map<string, MailDraft["by"]>();
    for (const d of drafts.data ?? [])
      if (d.threadId && !by.has(d.threadId)) by.set(d.threadId, d.by);
    return by;
  });
  const compose = () => void act("mail.draft", { text: "" });
  // Kept by id: new mail arriving above doesn't move e or # onto a different conversation.
  const sel = createSelection(list, (t) => t.id);
  const current = () => (onRow() === null ? sel.current() : undefined);
  const pick = (i: number) => {
    setOnRow(null);
    sel.select(i);
  };
  // A search's top row is next once typing pauses and it goes out, not at each key: until then
  // the list shown is still the one before. A space typed is the same search.
  let searched = untrack(term).trim();
  createEffect(() => {
    if (term().trim() === searched) return;
    searched = term().trim();
    untrack(sel.reset);
  });
  // Moving down with j: the next page comes before you reach the end.
  createEffect(() => {
    if (paging() && sel.index() >= list().length - 5) listed.more();
  });
  // Asked while it's open, as this pane: it turns to that lane.
  createEffect(() => {
    const to = asked();
    if (!to || to.pane !== props.pane) return;
    setAsked(null);
    setView("inbox");
    setQuery("");
    setLane(to.lane);
    setBundle(null);
    sel.reset();
  });
  const focused = () => layout.focused() === props.pane;
  const openBundle = (b: MailBundle | null) => {
    setBundle(b);
    setOnRow(null);
    sel.reset();
  };

  const open = (t: BundledThread | undefined, beside = false) => {
    if (!t) return;
    if (t.unread) void act("mail.mark_read", { ids: [t.id] });
    // Archiving it there moves on to the next one in this list.
    openedFrom(list, t.id);
    const route = { view: "thread" as const, id: t.id };
    if (beside) layout.open(route, { beside: true });
    else layout.show(route, props.pane);
  };
  onCleanup(() => listClosed(list));
  // Reply from the list: the conversation opens with the cursor in the reply.
  const replyFrom = (t: BundledThread | undefined) => {
    if (!t) return;
    open(t);
    void reply(t.id, drafts.data ?? []);
  };
  const archiveRow = (t: BundledThread | undefined) => {
    if (!t) return;
    if (t.inInbox) void archive(t.id);
    else void run("mail.unarchive", { ids: [t.id] }, "Back in the inbox.");
  };
  const run = async (name: string, input: Record<string, unknown>, done?: string) => {
    if ((await act(name, input)) && done) toast.show(done);
  };
  useHotkeys(
    mailKeys({
      focused,
      count: () => list().length + rows().length,
      index: () => {
        const at = onRow();
        return at === null ? sel.index() : list().length + at;
      },
      setIndex: (i) => (i < list().length ? pick(i) : setOnRow(i - list().length)),
      current,
      onBundle: () => {
        const at = onRow();
        return at === null ? undefined : rows()[at]?.bundle;
      },
      bundleOpen: () => inbox() && bundle() !== null,
      openBundle,
      open: (t) => open(t),
      archive: archiveRow,
      reply: replyFrom,
      compose,
      run,
    }),
  );

  const tab = (active: boolean) =>
    `rounded-md px-2 py-1 text-sm ${active ? "bg-sunk font-medium" : "text-muted hover:text-ink"}`;
  const syncing = () => (accounts.data ?? []).some((a) => !a.firstSyncDone);

  return (
    <div class="flex h-full flex-col">
      <PaneHeader title="Mail">
        <Show when={view() === "inbox" && !query()}>
          <button
            type="button"
            class={tab(lane() === "inbox")}
            onClick={() => {
              setLane("inbox");
              openBundle(null);
            }}
          >
            Inbox
          </button>
          <button type="button" class={tab(lane() === "reply")} onClick={() => setLane("reply")}>
            To reply
          </button>
          <button
            type="button"
            class={tab(lane() === "waiting")}
            onClick={() => setLane("waiting")}
          >
            Waiting
          </button>
          <span class="mx-1 h-4 w-px bg-line" />
        </Show>
        <select
          class="rounded-md border border-line bg-panel px-2 py-1 text-sm"
          aria-label="Which mail"
          value={view()}
          onChange={(e) => {
            setView(e.currentTarget.value as View);
            sel.reset();
          }}
        >
          <option value="inbox">Inbox</option>
          <option value="starred">Starred</option>
          <option value="sent">Sent</option>
          <option value="all">All mail</option>
          <option value="trash">Trash</option>
        </select>
        <Button size="sm" variant="primary" onClick={compose}>
          Write
        </Button>
        <input
          class="w-36 rounded-md border border-line bg-panel px-2 py-1 text-sm"
          type="search"
          placeholder="Search mail"
          aria-label="Search mail"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
      </PaneHeader>
      <MailSyncBanner accounts={accounts.data ?? []} />
      <div class="flex-1 overflow-auto">
        <Show when={fresh().length > 0}>
          <div class="space-y-3 border-b border-line p-4">
            <For each={fresh()}>
              {(id) => <Composer draft={(drafts.data ?? []).find((d) => d.id === id)!} />}
            </For>
          </div>
        </Show>
        <Show
          when={(accounts.data ?? []).length > 0 || accounts.isLoading}
          fallback={<Empty>No mail account yet. Connect Gmail in Settings.</Empty>}
        >
          <Show when={inbox() && bundle()}>
            {(b) => (
              <BundleHeader bundle={b()} count={countOf(b())} onBack={() => openBundle(null)} />
            )}
          </Show>
          <Show when={!threads.isLoading} fallback={<Skeleton />}>
            <Show
              when={!nothing()}
              fallback={
                <Empty>
                  {syncing()
                    ? "Bringing in your mail…"
                    : query()
                      ? "No mail matches that."
                      : "Nothing here."}
                </Empty>
              }
            >
              <Show when={bundled()}>
                <PeopleHeader
                  count={countOf("people")}
                  shown={list().length}
                  onAll={() => openBundle("people")}
                />
                <Show when={list().length === 0}>
                  <p class="border-b border-line px-4 py-3 text-sm text-muted">
                    No conversations with people in the inbox.
                  </p>
                </Show>
              </Show>
              <ul>
                <For each={list()}>
                  {(t, i) => (
                    <ThreadRow
                      t={t}
                      active={focused() && onRow() === null && i() === sel.index()}
                      outside={view() !== "inbox"}
                      lane={lane()}
                      drafted={drafted().get(t.id)}
                      onOpen={(beside) => {
                        pick(i());
                        open(t, beside);
                      }}
                      onArchive={() => archiveRow(t)}
                      onTask={() => void makeTask(t)}
                      onReply={() => {
                        pick(i());
                        replyFrom(t);
                      }}
                    />
                  )}
                </For>
              </ul>
              <Show when={bundled()}>
                <MorePeople
                  more={countOf("people") - list().length}
                  onAll={() => openBundle("people")}
                />
                <BundleRows
                  counts={counts.data ?? []}
                  active={focused() ? onRow() : null}
                  onOpen={openBundle}
                />
                <BundlesUnknown
                  loading={counts.isLoading}
                  failed={counts.isError && !counts.data}
                  onOpen={openBundle}
                />
              </Show>
              <Show when={paging()}>
                <div class="p-3 text-center" ref={(el) => onCleanup(whenSeen(el, listed.more))}>
                  <Button
                    size="sm"
                    disabled={listed.query.isFetchingNextPage}
                    onClick={() => listed.more()}
                  >
                    {listed.query.isFetchingNextPage ? "Loading…" : "Older conversations"}
                  </Button>
                </div>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
