// Made-up cards and desk views for the dev-only preview of the Inbox and notice panels
// (inbox.preview.ts), and a stand-in for Nook's side of the Inbox that answers here and sends
// nothing anywhere. Times are set against one fixed clock, so the shots read the same every run.

import type {
  InboxCard,
  InboxPhase,
  InboxTrouble,
  InboxView,
} from "@/bindings";
import type { InboxLink } from "./inboxTypes";
import type { DockNotice } from "./noticePanel";

/** The preview's clock: 09:00 on a Thursday. */
export const T = Date.parse("2026-10-29T09:00:00.000Z");
const ago = (mins: number) => new Date(T - mins * 60_000).toISOString();

const blank: InboxCard = {
  id: "",
  kind: "question",
  title: "",
  line: "",
  at: ago(2),
  url: "/inbox",
  outside: false,
  seen: false,
  approval_id: null,
  risk: null,
  question_id: null,
  choices: [],
  replies: [],
  recommended: null,
};

export const CARDS: Record<string, InboxCard> = {
  question: {
    ...blank,
    id: "c-question",
    kind: "question",
    title: "Which room should I book for Thursday's design review?",
    question_id: "q-1",
    choices: [
      "The small room, four seats",
      "The big room, with the screen",
      "Either one, whichever is free",
    ],
    recommended: 1,
  },
  approval: {
    ...blank,
    id: "c-approval",
    kind: "approval",
    title: "Send the invoice reminder to Dana?",
    line: "Gmail · to dana@example.com · “Friendly reminder: invoice 1042”",
    url: "/today",
    approval_id: "a-1",
    risk: "outward",
    at: ago(6),
  },
  finished: {
    ...blank,
    id: "c-finished",
    kind: "finished",
    title: "Launch notes drafted",
    line: "The draft is in Docs, with the three changes from Monday's call.",
    replies: ["Make it shorter", "Share it with the team"],
    at: ago(5),
  },
  brief: {
    ...blank,
    id: "c-brief",
    kind: "brief",
    title: "Your morning brief",
    line: "Three meetings, two replies owed, and the rent is due Friday.",
    url: "/today",
    at: ago(40),
  },
  wrap: {
    ...blank,
    id: "c-wrap",
    kind: "wrap",
    title: "Your evening wrap",
    line: "Five things done today; the dentist moved to Tuesday.",
    url: "/today",
    at: ago(15),
  },
};

export const TROUBLE: Record<string, InboxTrouble> = {
  offline: { word: "offline", says: "Hearth isn't answering right now." },
  no_hello: {
    word: "no_hello",
    says: "Windows Hello isn't set up for Nook on this PC, so the desk can't open here.",
  },
};

/** A fake desk in a given state: answers every act with its view, and takes answered cards away.
 * It hands the run its first view at once, as Nook's would have come before the Inbox opened. */
export function fakeDesk(
  phase: InboxPhase,
  cards: InboxCard[],
  trouble: InboxTrouble | null = null,
): InboxLink {
  let seq = 0;
  let open = false;
  let left = cards;
  const view = (): InboxView => ({
    seq: ++seq,
    open,
    phase,
    cards: phase === "open" ? left : [],
    total: phase === "open" ? left.length : 0,
    trouble,
    refused: null,
  });
  const gone = (pick: (c: InboxCard) => boolean) =>
    (left = left.filter((c) => !pick(c)));
  return {
    ask: async (act) => {
      if (act.kind === "open" || act.kind === "close")
        open = act.kind === "open";
      if (act.kind === "answer") gone((c) => c.question_id === act.question_id);
      if (act.kind === "decide") gone((c) => c.approval_id === act.approval_id);
      if (act.kind === "reply" || act.kind === "clear")
        gone((c) => c.id === act.id);
      return view();
    },
    onView: (handler) => handler(view()),
  };
}

/** The notices: what notify.rs sends for each kind, and the card the Inbox's own view has for it
 * while the desk is open, or none. */
export const NOTICES: {
  name: string;
  notice: DockNotice;
  card: InboxCard | null;
}[] = [
  {
    name: "notice question, desk shut",
    notice: {
      id: "c-question",
      kind: "question",
      heading: "Pip asks you something",
    },
    card: null,
  },
  {
    name: "notice question, desk open",
    notice: {
      id: "c-question",
      kind: "question",
      heading: "Pip asks you something",
    },
    card: CARDS.question!,
  },
  {
    name: "notice approval",
    notice: { id: "c-approval", kind: "approval", heading: "Pip needs a yes" },
    card: { ...CARDS.approval!, at: ago(0), outside: true },
  },
  {
    name: "notice finished",
    notice: {
      id: "c-finished",
      kind: "finished",
      heading: "Pip finished something",
    },
    card: { ...CARDS.finished!, at: ago(0) },
  },
  {
    name: "notice brief",
    notice: { id: "c-brief", kind: "brief", heading: "Your brief is ready" },
    card: { ...CARDS.brief!, at: ago(0) },
  },
  {
    name: "notice wrap, desk shut",
    notice: { id: "c-wrap", kind: "wrap", heading: "Your evening wrap" },
    card: null,
  },
];
