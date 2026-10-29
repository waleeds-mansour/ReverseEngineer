// The dock preview's chat with Pip (dock.ts, &show=chat): the real panel (chatPanel.ts) on a stand-in
// for Nook that answers with a long thread, so the chat grows as tall as it gets and the preview
// shows what a window shorter than that does to it (&show=chat in a 1080p window at 125 %).

import type { ChatLine, ChatView } from "@/bindings";
import type { ChatLink } from "../chatLink";
import { chatPanel } from "../chatPanel";
import type { NotchPanel } from "../notchPanel";

let seq = 0;

function thread(): ChatView {
  const lines: ChatLine[] = [];
  for (let i = 0; i < 10; i++) {
    lines.push({
      idx: 2 * i,
      who: "you",
      text: `What about item ${i + 1} on the list?`,
    });
    lines.push({
      idx: 2 * i + 1,
      who: "pip",
      text: `Item ${i + 1} is handled: I moved it to Friday and told the people it touches.`,
    });
  }
  return {
    seq: ++seq,
    open: true,
    desk: true,
    unlocking: false,
    conversation: "0b5e3c1e-2f7a-4f4e-9d36-3c1e2f7a4f4e",
    title: "Plan the week",
    lines,
    older: false,
    working: false,
    status: null,
    replies: ["Send it", "Make it shorter"],
    replies_outside: false,
    outside: null,
    locked: false,
    recent: [],
    link: "hearth://open/today?jarvis",
    trouble: null,
  };
}

const answer = () => Promise.resolve(thread());

const link: ChatLink = {
  list: answer,
  open: answer,
  send: answer,
  older: answer,
  unlock: answer,
  close: answer,
  onView: () => () => {},
};

export const chatFixture = (): NotchPanel => chatPanel(link);
