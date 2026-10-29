// The notch's chat with Pip, and its way to Nook in Hearth's app (src-tauri/src/hearth/chat.rs):
// the chat commands, and the views Nook sends on its own as "nook://chat" to the dock's window
// while Pip's words come in. The dev-only preview hands the panel a fake link instead
// (chat.preview.ts). The desk's secret never reaches the page: Nook holds it.

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type ChatView, commands, type Result } from "@/bindings";

export type { ChatItem, ChatLine, ChatView, ChatWho } from "@/bindings";

export const CHAT_EVENT = "nook://chat";

export interface ChatLink {
  /** The panel opened: the conversation it last showed, and the switcher, fresh. */
  list(): Promise<ChatView>;
  /** A conversation from the switcher, or null for a new one. */
  open(conversation: string | null): Promise<ChatView>;
  /** Your words to Pip; rejects with why they didn't go. */
  send(text: string): Promise<ChatView>;
  older(): Promise<ChatView>;
  unlock(): Promise<ChatView>;
  /** The panel closed; with `nook`, the conversation goes on in Hearth's window. */
  close(nook: boolean): Promise<ChatView>;
  /** Nook's own views; returns how to stop listening. */
  onView(handler: (view: ChatView) => void): () => void;
}

/** Whether a view should replace the one shown: a late one loses. */
export const newerChat = (current: ChatView | null, next: ChatView) =>
  current === null || next.seq >= current.seq;

const unwrap = async (r: Promise<Result<ChatView, string>>) => {
  const got = await r;
  if (got.status === "error") throw new Error(got.error);
  return got.data;
};

export const tauriChat: ChatLink = {
  list: () => unwrap(commands.chatList()),
  open: (conversation) => unwrap(commands.chatOpen(conversation)),
  send: (text) => unwrap(commands.chatSend(text)),
  older: () => unwrap(commands.chatOlder()),
  unlock: () => unwrap(commands.chatUnlock()),
  close: (nook) => unwrap(commands.chatClose(nook)),
  onView: (handler) => {
    // The dock's own window only, as the Inbox listens.
    const stop = getCurrentWebviewWindow().listen<ChatView>(CHAT_EVENT, (e) =>
      handler(e.payload),
    );
    return () => void stop.then((un) => un());
  },
};
