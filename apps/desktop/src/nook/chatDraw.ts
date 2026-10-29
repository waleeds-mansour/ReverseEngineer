// The notch's chat with Pip, drawn (chatPanel.ts decides when): the header with the conversation's
// title, its switcher, "Open in Nook" and ×; the lines; Pip's working arc and status; the ready
// replies; and the box you type in, with its mic for later. Every word Hearth sends is set as text,
// never as markup, since Pip's words may carry outside content's.

import type { ChatItem, ChatLine } from "./chatLink";
import { ago, blocks, SEND_MAX, type Span } from "./chatText";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function button(cls: string, words: string, label?: string) {
  const b = el("button", cls);
  b.type = "button";
  b.textContent = words;
  if (label) b.setAttribute("aria-label", label);
  return b;
}

/** Sets an attribute, or with null takes it away; only when it changes. */
export function attr(e: Element, name: string, value: string | null) {
  if (value === null) {
    if (e.hasAttribute(name)) e.removeAttribute(name);
  } else if (e.getAttribute(name) !== value) e.setAttribute(name, value);
}

export function text(e: Element, value: string) {
  if (e.textContent !== value) e.textContent = value;
}

const SVG = "http://www.w3.org/2000/svg";

/** A small mic, drawn in the box's own ink. */
function micGlyph() {
  const s = document.createElementNS(SVG, "svg");
  s.setAttribute("viewBox", "0 0 16 16");
  s.setAttribute("aria-hidden", "true");
  const body = document.createElementNS(SVG, "rect");
  for (const [k, v] of Object.entries({
    x: "5.5",
    y: "1.5",
    width: "5",
    height: "8.5",
    rx: "2.5",
  }))
    body.setAttribute(k, v);
  const stand = document.createElementNS(SVG, "path");
  stand.setAttribute("d", "M3 7.5a5 5 0 0 0 10 0M8 12.5v2");
  s.append(body, stand);
  return s;
}

function spans(into: HTMLElement, all: Span[]) {
  for (const s of all) {
    if (s.kind === "text") into.append(s.text);
    else if (s.kind === "code")
      into.append(Object.assign(el("code"), { textContent: s.text }));
    else if (s.kind === "bold")
      into.append(Object.assign(el("strong"), { textContent: s.text }));
    else {
      // Shown, never opened from here: the address is in its title, and its host beside words
      // that say something else.
      const link = el("span", "nc-link");
      link.textContent = s.text;
      link.title = s.url;
      into.append(link);
      if (s.host)
        into.append(
          Object.assign(el("span", "nc-host"), { textContent: ` (${s.host})` }),
        );
    }
  }
}

/** Pip's words, with light markdown. */
export function pipWords(words: string): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const b of blocks(words)) {
    if (b.kind === "code") {
      const pre = el("pre", "nc-pre");
      pre.textContent = b.text;
      f.append(pre);
    } else if (b.kind === "head") {
      const h = el("p", "nc-h");
      spans(h, b.spans);
      f.append(h);
    } else if (b.kind === "list") {
      const list = el(b.ordered ? "ol" : "ul", "nc-list");
      for (const item of b.items) {
        const li = el("li");
        spans(li, item);
        list.append(li);
      }
      f.append(list);
    } else {
      const p = el("p");
      b.lines.forEach((line, i) => {
        if (i > 0) p.append(el("br"));
        spans(p, line);
      });
      f.append(p);
    }
  }
  return f;
}

/** A line: your words in a bubble, Pip's as text, Nook's notes small. */
export function drawLine(line: ChatLine): HTMLElement {
  const li = el("li", "nc-line");
  li.dataset.who = line.who;
  li.dataset.idx = String(line.idx);
  if (line.who === "pip") li.append(pipWords(line.text));
  else {
    const said = el("p", line.who === "you" ? "nc-bubble" : "nc-note");
    said.textContent = line.text;
    li.append(said);
  }
  return li;
}

export interface ChatParts {
  root: HTMLElement;
  head: HTMLElement;
  switcher: HTMLButtonElement;
  title: HTMLElement;
  nook: HTMLAnchorElement;
  close: HTMLButtonElement;
  menu: HTMLElement;
  banner: HTMLElement;
  badge: HTMLElement;
  scroll: HTMLElement;
  inner: HTMLElement;
  older: HTMLButtonElement;
  lines: HTMLOListElement;
  empty: HTMLElement;
  locked: HTMLElement;
  unlock: HTMLButtonElement;
  newer: HTMLButtonElement;
  footer: HTMLElement;
  working: HTMLElement;
  status: HTMLElement;
  replies: HTMLElement;
  trouble: HTMLElement;
  box: HTMLTextAreaElement;
  mic: HTMLButtonElement;
}

export function buildChat(): ChatParts {
  const root = el("section", "nc");
  root.setAttribute("aria-label", "Chat with Pip");

  const head = el("header", "nc-head");
  const switcher = button("nc-switch", "");
  switcher.setAttribute("aria-haspopup", "listbox");
  const title = el("span", "nc-title");
  switcher.append(
    title,
    Object.assign(el("span", "nc-chev"), { textContent: "▾" }),
  );
  const nook = el("a", "nc-nook");
  nook.textContent = "Open in Nook";
  const close = button("nc-x", "×", "Close");
  head.append(switcher, nook, close);

  const menu = el("div", "nc-menu");
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Conversations");
  menu.hidden = true;

  const banner = el("p", "nc-banner");
  const badge = el("span", "nc-badge");
  banner.append(badge, " Pip checks with you before acting here.");
  banner.title =
    "Text from outside Nook could try to steer Pip, so for the rest of this conversation it checks with you before acting outside it. A new conversation starts fresh.";

  const scroll = el("div", "nc-scroll");
  const inner = el("div", "nc-inner");
  const older = button("nc-older", "Earlier messages");
  const lines = el("ol", "nc-lines");
  lines.setAttribute("aria-live", "polite");
  const empty = el("p", "nc-empty");
  empty.textContent = "Ask Pip anything. Its answers come here.";
  const locked = el("div", "nc-locked");
  const unlock = button("nc-unlock", "Unlock with Windows Hello");
  locked.append(
    Object.assign(el("p"), {
      textContent: "This conversation opens with Windows Hello.",
    }),
    unlock,
  );
  inner.append(older, lines, empty, locked);
  scroll.append(inner);
  const newer = button("nc-newer", "New messages ↓");

  const footer = el("footer", "nc-foot");
  const working = el("p", "nc-working");
  const status = el("span", "nc-status");
  working.append(el("i", "nc-ring"), status);
  const replies = el("div", "nc-replies");
  const trouble = el("p", "nc-trouble");
  trouble.setAttribute("role", "status");
  const field = el("div", "nc-field");
  const box = el("textarea", "nc-box");
  box.rows = 1;
  // chat.send's limit; maxLength counts UTF-16 units as Hearth does, and cuts a paste to fit.
  box.maxLength = SEND_MAX;
  box.placeholder = "Ask Pip…";
  box.setAttribute("aria-label", "Message Pip");
  const mic = el("button", "nc-mic");
  mic.type = "button";
  mic.disabled = true;
  mic.title = "Talk (coming soon)";
  mic.setAttribute("aria-label", "Talk (coming soon)");
  mic.append(micGlyph());
  field.append(box, mic);
  // "New messages" floats just over the foot, whatever the foot holds.
  footer.append(newer, working, replies, trouble, field);

  root.append(head, menu, banner, scroll, footer);
  return {
    root,
    head,
    switcher,
    title,
    nook,
    close,
    menu,
    banner,
    badge,
    scroll,
    inner,
    older,
    lines,
    empty,
    locked,
    unlock,
    newer,
    footer,
    working,
    status,
    replies,
    trouble,
    box,
    mic,
  };
}

export interface MenuActs {
  pick(id: string): void;
  fresh(): void;
  unlock(): void;
}

/** The switcher's list: a new conversation, the recent ones, and with the desk shut, the way to
 * the rest. */
export function drawMenu(
  menu: HTMLElement,
  recent: ChatItem[],
  current: string | null,
  desk: boolean,
  now: number,
  acts: MenuActs,
) {
  const rows: HTMLElement[] = [];
  const fresh = button("nc-item nc-item-new", "New conversation");
  fresh.setAttribute("role", "option");
  fresh.addEventListener("click", acts.fresh);
  rows.push(fresh);
  for (const c of recent) {
    const row = el("button", "nc-item");
    row.type = "button";
    row.setAttribute("role", "option");
    attr(row, "aria-current", c.id === current ? "true" : null);
    const name = Object.assign(el("span", "nc-item-title"), {
      textContent: c.title,
    });
    const when = Object.assign(el("span", "nc-item-at"), {
      textContent: ago(c.at, now),
    });
    row.append(name, when);
    if (c.working) row.append(el("i", "nc-ring nc-ring-small"));
    row.addEventListener("click", () => acts.pick(c.id));
    rows.push(row);
  }
  if (!desk) {
    const lock = button(
      "nc-item nc-item-lock",
      "Unlock with Windows Hello to see all your conversations",
    );
    lock.setAttribute("role", "option");
    lock.addEventListener("click", acts.unlock);
    rows.push(lock);
  }
  menu.replaceChildren(...rows);
}
