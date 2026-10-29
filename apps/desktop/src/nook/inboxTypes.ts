// What the dock's Inbox and Nook say to each other (inboxview.rs, dockinbox.rs). The page asks
// with an InboxAct, inside nook_ui's UiCmd, and gets an InboxView back; Nook also sends one on its
// own as "nook://inbox" when the desk opens after Windows Hello, shuts, or new cards come. The
// types are bindings.ts's, as Rust's specta writes them.
//
// A card is one of the desk's (packages/modules/src/desk/cards.ts): what Pip asks (approval), one
// of its questions with choices, finished work (with the ready replies its turn offered, if any),
// the brief and the evening wrap. The desk's secret never reaches the page: Nook holds it.

import type { InboxAct, InboxView } from "@/bindings";

export type {
  InboxAct,
  InboxCard,
  InboxPhase,
  InboxTrouble,
  InboxView,
} from "@/bindings";

export const INBOX_EVENT = "nook://inbox";

export interface InboxLink {
  ask(act: InboxAct): Promise<InboxView>;
  onView(handler: (view: InboxView) => void): void;
}

/** Whether a view should replace the one shown: a late one loses. */
export const newerView = (current: InboxView | null, next: InboxView) =>
  current === null || next.seq >= current.seq;
