// The Inbox's state for the page's whole life (inboxPanel.ts draws it, inboxFlow.ts has its keys
// and clock): Nook's last InboxView, which card is in front, the wait every answer has, and the
// words typed in the reply field. It outlives the notch's panel, so the Inbox opens again on the
// card it showed, with those words still there. An answer still waiting when the panel closes
// (Esc, ×, a click elsewhere, another panel in its place) or when the desk stops being open is
// taken back, never sent unseen: the card stays on the desk to answer again, as a sent yes can't
// be undone. An answer already sent finishes its "Sent" on the clock. Each act rides nook_ui as
// UiCmd's "inbox"; Nook's own views come as "nook://inbox" to the dock's window only
// (dockinbox.rs). The dev-only preview hands it a fake link and its own clock instead.
//
// What Nook's view says goes: the desk's cards once Windows Hello has opened it, "Unlock with
// Windows Hello" while it is shut, plainly why when it can't open here, and the Inbox closed when
// Nook closed it (a click elsewhere took the keyboard). Nothing here plays a sound.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Link } from "./link";
import {
  begin,
  current,
  type Flow,
  openAt,
  press,
  refresh,
  refused,
  SENT_MS,
  type Step,
  takeBack,
  tick,
  typed,
  WAIT_MS,
} from "./inboxFlow";
import { toToday } from "./inboxDraw";
import {
  INBOX_EVENT,
  type InboxAct,
  type InboxCard,
  type InboxLink,
  type InboxView,
  newerView,
} from "./inboxTypes";

/** The Inbox's way to Nook in Hearth's app. */
export function inboxLink(link: Link): InboxLink {
  return {
    ask: async (act) => {
      const reply = await link.ask({ kind: "inbox", act });
      if (!reply.inbox) throw new Error("Nook sent no Inbox");
      return reply.inbox;
    },
    onView: (handler) => {
      void getCurrentWebviewWindow().listen<InboxView>(INBOX_EVENT, (e) =>
        handler(e.payload),
      );
    },
  };
}

export interface RunOptions {
  now?: () => number;
  /** False for the preview's still shots: answers then wait for good. */
  clock?: boolean;
}

export interface InboxRun {
  view(): InboxView | null;
  flow(): Flow;
  now(): number;
  /** The panel opened, at a card if given: Nook lists the desk and lets the window take keys. */
  open(at?: string): void;
  /** The panel closed: an answer still waiting is taken back, and Nook is told, unless it
   * closed the Inbox itself. */
  close(): void;
  isOpen(): boolean;
  /** A key from the notch, the field aside; true when it did something. */
  press(key: string): boolean;
  /** Enter in the "Reply to Pip…" field; true when the words wait to go. */
  typed(words: string): boolean;
  /** The words in the reply field for a card, kept until they go. */
  words(id: string): string;
  setWords(id: string, words: string): void;
  /** The message's one button, or Enter while there is no card: unlock, try again, or Today. */
  gate(): boolean;
  card(id: string): InboxCard | undefined;
  /** The clock's step: what its timer does, and the preview's still shots by hand. */
  tick(): void;
  /** Called on every change, with `shut` when the Inbox closed itself (O, Today, or Nook). */
  watch(fn: (shut: boolean) => void): () => void;
}

export function startRun(link: InboxLink, opts: RunOptions = {}): InboxRun {
  const now = opts.now ?? (() => Date.now());
  let view: InboxView | null = null;
  let flow: Flow = begin([], now());
  let open = false;
  /** The card a notice opened the Inbox at, until the list has it. */
  let want: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The reply field's words, for the card they were typed on. */
  let draft: { id: string; words: string } | null = null;
  /** The cards already marked seen this run, so each is told once. */
  const marked = new Set<string>();
  const watchers = new Set<(shut: boolean) => void>();

  const changed = (shut = false) => {
    for (const w of watchers) w(shut);
  };

  /** Nook is told what the owner has seen of the card in front, while the Inbox is open. */
  const markSeen = () => {
    const card = view?.phase === "open" && open ? current(flow) : null;
    if (card && !card.seen) send({ kind: "seen", id: card.id });
  };

  const send = (act: InboxAct) => {
    if (act.kind === "seen") {
      if (marked.has(act.id)) return;
      marked.add(act.id);
    }
    link.ask(act).then(
      (v) => apply(v, false),
      () => {
        if (act.kind === "seen") return;
        flow = refused(flow, "Nook didn't take that. Try again.", now());
        changed();
      },
    );
  };

  const apply = (v: InboxView, pushed: boolean) => {
    if (!newerView(view, v)) return;
    const first = view?.phase !== "open" && v.phase === "open";
    view = v;
    flow = first ? begin(v.cards, now()) : refresh(flow, v.cards, now());
    if (v.refused && flow.phase !== "ask")
      flow = refused(flow, v.refused, now());
    // Shut, opening again or in trouble: what waited can't be seen or stopped, so it doesn't go.
    if (v.phase !== "open") flow = takeBack(flow, now());
    if (want && flow.cards.some((c) => c.id === want)) {
      flow = openAt(flow, want);
      want = null;
    }
    // Nook closes it on its own (a click elsewhere) with a view it sends; an answer to one of the
    // page's acts can be older than the page's last open.
    const shut = pushed && !v.open && open;
    if (shut) {
      open = false;
      flow = takeBack(flow, now());
    }
    markSeen();
    schedule();
    changed(shut);
  };

  /** The clock: the next moment an answer goes or "Sent" gives way. */
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const left =
      flow.phase === "wait" ? WAIT_MS : flow.phase === "sent" ? SENT_MS : null;
    if (left === null || opts.clock === false) return;
    timer = setTimeout(
      () => run(tick(flow, Math.max(now(), flow.since + left))),
      left - (now() - flow.since),
    );
  };

  /** Carries out a step; true when it changed anything. */
  const run = (s: Step): boolean => {
    const used = s.flow !== flow || s.out.length > 0 || !!s.close;
    flow = s.flow;
    // Typed words are done with once they went.
    if (flow.phase === "sent" && draft?.id === flow.pick?.id) draft = null;
    for (const act of s.out) send(act);
    // Esc's close is sent above; O's show closes the Inbox on Nook's side by itself.
    const shut = !!s.close && open;
    if (shut) open = false;
    markSeen();
    schedule();
    changed(shut);
    return used;
  };

  const api: InboxRun = {
    view: () => view,
    flow: () => flow,
    now,
    open(at) {
      want = at ?? null;
      if (want && flow.cards.some((c) => c.id === want)) {
        flow = openAt(flow, want);
        want = null;
      }
      open = true;
      send({ kind: "open" });
      changed();
    },
    close() {
      want = null;
      flow = takeBack(flow, now());
      schedule();
      if (!open) return;
      open = false;
      send({ kind: "close" });
    },
    isOpen: () => open,
    press(key) {
      if (view?.phase !== "open") return key === "Enter" ? api.gate() : false;
      // Esc with nothing waiting is the notch's: it closes the panel, which tells Nook.
      if (key === "Escape" && flow.phase !== "wait") return false;
      return run(press(flow, key, now()));
    },
    typed(words) {
      if (flow.phase !== "ask") return false;
      const s = typed(flow, words, now());
      run(s);
      return s.flow.phase === "wait";
    },
    words: (id) => (draft?.id === id ? draft.words : ""),
    setWords(id, words) {
      draft = words ? { id, words } : null;
    },
    gate() {
      if (!view || view.phase === "opening" || view.phase === "open")
        return false;
      if (view.phase === "shut") send({ kind: "unlock" });
      else if (!toToday(view)) send({ kind: "open" });
      else {
        send({ kind: "today" });
        open = false;
        changed(true);
      }
      return true;
    },
    card: (id) => view?.cards.find((c) => c.id === id),
    tick: () => void run(tick(flow, now())),
    watch(fn) {
      watchers.add(fn);
      return () => void watchers.delete(fn);
    },
  };
  link.onView((v) => apply(v, true));
  return api;
}
