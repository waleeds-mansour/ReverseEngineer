// The dev-only preview of the notch's chat with Pip (chatPanel.ts), mounted in a black box like the
// notch's, padded 16 px and zoomed 150 %, fed a fixture from the query: ?s= empty, markdown,
// working, replies, shut (a conversation that needs the desk), shutmenu (the switcher with the
// desk shut) or long (a long thread scrolled up as a new line comes). A stand-in for Rust answers
// as Rust would in the plain cases, what was asked is kept in window.__chatAsked, and keys go to
// the panel as the notch hands them over. vite.config.ts never builds this page; the shots of it
// are taken headless (D:\hearth-build\loop\n3\shots.mjs).

import "./nook.css";
import type { ChatLine, ChatView } from "@/bindings";
import type { ChatLink } from "./chatLink";
import { chatPanel } from "./chatPanel";

const q = new URLSearchParams(location.search);
const root = document.documentElement;
root.dataset.theme = "dark";
if (q.get("still") === "1") root.setAttribute("data-reduced", "");

const style = document.createElement("style");
style.textContent = `
  html.chat-preview { background: #2b2d33; }
  html.chat-preview body { margin: 0; padding: 24px; }
  .chat-notch { display: inline-block; padding: 16px; border-radius: 0 0 26px 26px;
    background: #000; zoom: 1.5; }`;
document.head.append(style);

const ID = "0b5e3c1e-2f7a-4f4e-9d36-3c1e2f7a4f4e";
let seq = 0;
let idx = 0;
const you = (text: string): ChatLine => ({ idx: idx++, who: "you", text });
const pip = (text: string): ChatLine => ({ idx: idx++, who: "pip", text });

const base = (): ChatView => ({
  seq: ++seq,
  open: true,
  desk: true,
  unlocking: false,
  conversation: ID,
  title: "Plan the week",
  lines: [],
  older: false,
  working: false,
  status: null,
  replies: [],
  replies_outside: false,
  outside: null,
  locked: false,
  recent: [
    {
      id: ID,
      title: "Plan the week",
      at: new Date(Date.now() - 4 * 60_000).toISOString(),
      working: false,
    },
    {
      id: "1b5e3c1e-2f7a-4f4e-9d36-3c1e2f7a4f4e",
      title: "Dentist on Thursday",
      at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      working: true,
    },
    {
      id: "2b5e3c1e-2f7a-4f4e-9d36-3c1e2f7a4f4e",
      title: "Reply to Sam about the venue",
      at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      working: false,
    },
  ],
  link: "hearth://open/today?jarvis",
  trouble: null,
});

const markdown = [
  "Here's your week, roughly:",
  "",
  "# Monday",
  "- **9:30** standup, then the `quarterly-review` doc",
  "- Lunch with Sam at [Fig & Olive](https://figandolive.example/reserve)",
  "",
  "1. Book the dentist for Thursday",
  "2. Send the venue deposit before Friday",
  "",
  "The invoice is at https://billing.example.com/inv/2231. I haven't opened it.",
].join("\n");

const fixtures: Record<string, () => ChatView> = {
  empty: () => ({ ...base(), conversation: null, title: "New conversation" }),
  markdown: () => ({
    ...base(),
    lines: [you("What does my week look like?"), pip(markdown)],
    outside: "an email from billing.example.com",
  }),
  working: () => ({
    ...base(),
    lines: [you("Find a time with Sam next week for the venue walk-through")],
    working: true,
    status: "Thinking about what you asked",
  }),
  replies: () => ({
    ...base(),
    title: "Reply to Sam about the venue",
    lines: [
      you("Draft a reply to Sam saying Thursday works"),
      pip(
        "Here's a draft:\n\nHi Sam, Thursday at 3 works for me. See you at the venue.\n\nShall I send it?",
      ),
    ],
    replies: ["Send it", "Make it shorter"],
    replies_outside: true,
    outside: "Sam's email",
  }),
  shut: () => ({
    ...base(),
    desk: false,
    // Nook sends a locked conversation's view with no title, as its title is its first words.
    title: "",
    locked: true,
    recent: [],
  }),
  shutmenu: () => ({
    ...base(),
    desk: false,
    title: "Remind me about the dentist",
    lines: [
      you("Remind me about the dentist on Thursday"),
      pip("Done: Thursday at 8:30, an hour before."),
    ],
    recent: [
      { id: ID, title: "Remind me about the dentist", at: "", working: false },
    ],
  }),
  long: () => {
    const lines: ChatLine[] = [];
    for (let i = 0; i < 14; i++) {
      lines.push(
        you(`Question ${i + 1}: what about item ${i + 1} on the list?`),
      );
      lines.push(
        pip(
          `Item ${i + 1} is handled. I moved it to Friday and told the people it touches.`,
        ),
      );
    }
    return { ...base(), lines, older: true };
  },
};

const pick = q.get("s") ?? "markdown";
let view = (fixtures[pick] ?? fixtures.markdown!)();
const asked: string[] = [];
(window as unknown as { __chatAsked: string[] }).__chatAsked = asked;
let push: (v: ChatView) => void = () => {};
const again = (patch: Partial<ChatView>) => {
  view = { ...view, ...patch, seq: ++seq };
  return Promise.resolve(view);
};

const link: ChatLink = {
  list: () => (asked.push("list"), again({})),
  open: (c) => (asked.push(`open:${c}`), again(c ? {} : fixtures.empty!())),
  send: (text) => {
    asked.push(`send:${text}`);
    return again({
      lines: [...view.lines, you(text)],
      working: true,
      status: "Thinking",
      replies: [],
    });
  },
  older: () => (asked.push("older"), again({ older: false })),
  unlock: () => (asked.push("unlock"), again({ unlocking: true })),
  close: (nook) => (asked.push(`close:${nook}`), again({ open: false })),
  onView: (handler) => {
    push = handler;
    return () => {};
  },
};

const host = document.getElementById("notch")!;
const panel = chatPanel(link);
const fit = () => {
  const { wide, tall } = panel.size();
  host.style.width = `${wide}px`;
  host.style.height = `${tall}px`;
};
panel.onResize(fit);
panel.onClose?.(() => asked.push("closed"));
panel.mount(host);
fit();
// The notch hands keys to the panel and closes it on an Esc the panel didn't use.
document.addEventListener("keydown", (e) => {
  if (!panel.key?.(e) && e.key === "Escape") asked.push("closed");
});

if (pick === "shutmenu")
  setTimeout(
    () => document.querySelector<HTMLElement>(".nc-switch")?.click(),
    50,
  );
if (pick === "long")
  setTimeout(() => {
    const s = document.querySelector<HTMLElement>(".nc-scroll")!;
    s.scrollTop = 120;
    s.dispatchEvent(new Event("scroll"));
    setTimeout(
      () =>
        push({
          ...view,
          seq: ++seq,
          lines: [...view.lines, pip("Also: Sam confirmed Friday.")],
        }),
      50,
    );
  }, 100);
