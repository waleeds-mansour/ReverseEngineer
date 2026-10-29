// The chat with Pip inside the notch (notchPanel.ts's kind "chat"): clicking Pip's mark opens it
// instead of Hearth's window. It draws only its content, 420 px wide and as tall as that content
// up to 560, on the notch's black; the notch places it, pads it and gives it the keyboard.
//
// What it shows comes from Nook as a ChatView (src-tauri/src/hearth/chat.rs): the conversation it
// last showed, or the one it was opened on, with the desk's recent conversations in the switcher
// once Windows Hello has opened the desk, and without it only the app's own, with a way to unlock
// the rest. Your words sit right in a bubble and Pip's left as text with light markdown; while Pip
// works the dock's blue arc turns beside its status, and Nook sends each new line as it comes.
// Enter sends, Shift+Enter starts a new line, and Esc closes the switcher, or else the panel. The
// list stays at the newest line unless you scrolled up, and then "New messages" takes you down.

import "./chatPanel.css";
import "./chatLines.css";
import {
  attr,
  buildChat,
  type ChatParts,
  drawLine,
  drawMenu,
  text,
} from "./chatDraw";
import { type ChatLink, type ChatView, newerChat, tauriChat } from "./chatLink";
import { atBottom, chatKey, SEND_MAX } from "./chatText";
import { type NotchPanel, PANEL_MAX, registerPanel } from "./notchPanel";

/** The panel's width, and the tallest it grows, in CSS px at 1x. */
export const CHAT_WIDE = PANEL_MAX.wide;
export const CHAT_TALL = Math.min(560, PANEL_MAX.tall);
/** The shortest it is, so the header and the box always fit. */
const MIN_TALL = 132;
/** The box grows with Shift+Enter's lines up to this. */
const BOX_TALL = 96;

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Said once the box holds as much as a message can. */
const FULL = `That's as long as a message can be: ${SEND_MAX.toLocaleString("en-US")} characters.`;
const lineKey = (l: ChatView["lines"][number]) =>
  `${l.idx}:${l.who}:${l.text.length}`;

export function chatPanel(
  link: ChatLink,
  arg?: string,
  now: () => number = () => Date.now(),
): NotchPanel {
  let p: ChatParts | null = null;
  let view: ChatView | null = null;
  let tall = MIN_TALL;
  let menuOpen = false;
  let sending = false;
  let closed = false;
  /** At the newest line: new ones scroll into view. */
  let pinned = true;
  /** Why your last message didn't go, until the next one does. */
  let failed: string | null = null;
  /** How far from the bottom the list was scrolled before a draw. */
  let fromBottom = 0;
  /** The lines drawn, by key in order, and the conversation they're from. */
  let drawn: string[] = [];
  let drawnFor: string | null | undefined;
  const resized: (() => void)[] = [];
  const closers: (() => void)[] = [];
  const stops: (() => void)[] = [];

  const apply = (v: ChatView) => {
    if (!newerChat(view, v)) return;
    const before = view;
    view = v;
    draw(before);
  };
  const ask = (r: Promise<ChatView>) =>
    r.then(
      (v) => {
        // It went through, so what failed before no longer stands.
        const had = failed !== null;
        failed = null;
        if (newerChat(view, v)) apply(v);
        else if (had) draw(view);
      },
      (e) => {
        failed = said(e);
        draw(view);
      },
    );

  /** How tall the content would be, the switcher's room counted while it is open. */
  const measure = () => {
    if (!p) return;
    const { root, scroll, inner, head, menu } = p;
    let want = root.offsetHeight - scroll.clientHeight + inner.offsetHeight;
    if (menuOpen)
      want = Math.max(want, head.offsetHeight + menu.scrollHeight + 12);
    const next = Math.round(Math.min(CHAT_TALL, Math.max(MIN_TALL, want)));
    if (next === tall) return;
    tall = next;
    root.style.height = `${tall}px`;
    if (pinned) scroll.scrollTop = scroll.scrollHeight;
    for (const cb of resized) cb();
  };

  /**
   * The lines. New ones are added at the end and nothing else is touched, so a screen reader reads
   * only those (the list is aria-live) and a selection stays. The list is drawn afresh only for
   * another conversation, older lines coming in above, or a line landing in between.
   */
  const drawLines = (v: ChatView) => {
    if (!p) return;
    const lines = v.locked ? [] : v.lines;
    const keys = lines.map(lineKey);
    const grows =
      drawnFor === v.conversation &&
      drawn.length <= keys.length &&
      drawn.every((k, i) => keys[i] === k);
    if (grows) p.lines.append(...lines.slice(drawn.length).map(drawLine));
    else p.lines.replaceChildren(...lines.map(drawLine));
    drawn = keys;
    drawnFor = v.conversation;
  };

  const scrollAfter = (before: ChatView | null, v: ChatView) => {
    if (!p) return;
    const s = p.scroll;
    const first = (x: ChatView | null) => x?.lines[0]?.idx ?? -1;
    const last = (x: ChatView | null) =>
      x ? (x.lines[x.lines.length - 1]?.idx ?? -1) : -1;
    if (!before || before.conversation !== v.conversation || pinned) {
      s.scrollTop = s.scrollHeight;
      pinned = true;
    } else if (first(v) < first(before) && last(v) === last(before)) {
      // Older lines came in above: what you were reading stays where it was.
      s.scrollTop = s.scrollHeight - fromBottom;
    } else if (last(v) > last(before)) {
      attr(p.newer, "data-show", "");
    }
    if (pinned) attr(p.newer, "data-show", null);
  };

  const draw = (before: ChatView | null) => {
    if (!p || !view) return;
    const v = view;
    fromBottom = p.scroll.scrollHeight - p.scroll.scrollTop;
    // A locked conversation's title is its first words, so Nook sends none.
    text(
      p.title,
      v.locked ? "Locked conversation" : v.title || "New conversation",
    );
    attr(p.switcher, "aria-expanded", menuOpen ? "true" : "false");
    attr(p.nook, "href", v.link || null);
    p.banner.hidden = !v.outside || v.locked;
    text(p.badge, `Read ${v.outside ?? "outside content"}`);
    drawLines(v);
    p.older.hidden = !v.older || v.locked;
    p.empty.hidden = v.locked || v.lines.length > 0 || v.working;
    p.locked.hidden = !v.locked;
    p.unlock.disabled = v.unlocking;
    text(
      p.unlock,
      v.unlocking ? "Waiting for Windows Hello…" : "Unlock with Windows Hello",
    );
    p.working.hidden = !v.working;
    text(p.status, v.status ?? "Thinking");
    drawReplies(v);
    const trouble = failed ?? v.trouble;
    p.trouble.hidden = !trouble;
    text(p.trouble, trouble ?? "");
    p.box.disabled = v.locked;
    if (menuOpen) drawSwitcher();
    measure();
    scrollAfter(before, v);
  };

  const drawReplies = (v: ChatView) => {
    if (!p) return;
    const chips = (v.locked ? [] : v.replies).map((r) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "nc-chip";
      chip.textContent = r;
      if (v.replies_outside) {
        const tag = document.createElement("span");
        tag.className = "nc-outside";
        tag.textContent = "from outside";
        chip.append(tag);
      }
      chip.addEventListener("click", () => void send(r));
      return chip;
    });
    p.replies.replaceChildren(...chips);
    p.replies.hidden = chips.length === 0;
  };

  const drawSwitcher = () => {
    if (!p || !view) return;
    drawMenu(p.menu, view.recent, view.conversation, view.desk, now(), {
      pick: (id) => {
        toggleMenu(false);
        void ask(link.open(id));
      },
      fresh: () => {
        toggleMenu(false);
        void ask(link.open(null));
      },
      unlock: () => {
        toggleMenu(false);
        void ask(link.unlock());
      },
    });
  };

  const toggleMenu = (open: boolean) => {
    if (!p) return;
    menuOpen = open;
    p.menu.hidden = !open;
    attr(p.switcher, "aria-expanded", open ? "true" : "false");
    if (open) {
      drawSwitcher();
      // Fresh from Nook: the desk's list may have moved since the panel opened.
      void ask(link.list());
      (p.menu.querySelector("[aria-current]") ?? p.menu.firstElementChild)
        ?.closest("button")
        ?.focus();
    } else p.box.focus();
    measure();
  };

  const moveInMenu = (by: number) => {
    if (!p) return;
    const items = [...p.menu.querySelectorAll<HTMLButtonElement>("button")];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    items[Math.max(0, Math.min(items.length - 1, at + by))]?.focus();
  };

  const grow = () => {
    if (!p) return;
    const b = p.box;
    b.style.height = "auto";
    b.style.height = `${Math.min(BOX_TALL, Math.max(36, b.scrollHeight))}px`;
  };

  /** The box stops at SEND_MAX (its maxLength, which also cuts a paste): say so when it's full. */
  const onInput = () => {
    if (!p) return;
    grow();
    const full = p.box.value.length >= SEND_MAX;
    if (full === (failed === FULL)) return;
    if (full) failed = FULL;
    else if (failed === FULL) failed = null;
    draw(view);
  };

  async function send(words: string) {
    if (!p || !view || view.locked) return;
    const typed = words.trim();
    if (!typed || sending) return;
    sending = true;
    const fromBox = p.box.value.trim() === typed;
    if (fromBox) p.box.value = "";
    grow();
    try {
      const v = await link.send(typed);
      failed = null;
      pinned = true;
      apply(v);
      draw(view);
    } catch (e) {
      // It didn't go: what you typed comes back, unless you've typed more since.
      if (fromBox && p && !p.box.value) p.box.value = typed;
      grow();
      failed = said(e);
      draw(view);
    } finally {
      sending = false;
    }
  }

  const close = (nook: boolean) => {
    if (closed) return;
    closed = true;
    void link.close(nook).catch(() => {});
    for (const cb of closers) cb();
  };

  /** A key, used or not: Esc that isn't the switcher's is the notch's, which closes the panel. */
  const handle = (e: KeyboardEvent): boolean => {
    if (e.defaultPrevented) return true;
    if (!p) return false;
    const act = chatKey(e, menuOpen);
    if (act === null) return false;
    if (act === "send" && document.activeElement !== p.box) return false;
    e.preventDefault();
    if (act === "send") void send(p.box.value);
    else if (act === "close_menu") toggleMenu(false);
    else if (act === "menu_up") moveInMenu(-1);
    else if (act === "menu_down") moveInMenu(1);
    else (document.activeElement as HTMLElement | null)?.click();
    return true;
  };

  return {
    kind: "chat",
    wantsKeys: true,
    size: () => ({ wide: CHAT_WIDE, tall }),
    mount(host) {
      p = buildChat();
      const parts = p;
      parts.root.style.height = `${tall}px`;
      host.append(parts.root);
      parts.root.addEventListener("keydown", (e) => void handle(e));
      parts.switcher.addEventListener("click", () => toggleMenu(!menuOpen));
      parts.close.addEventListener("click", () => close(false));
      parts.nook.addEventListener("click", (e) => {
        e.preventDefault();
        close(true);
      });
      parts.older.addEventListener("click", () => void ask(link.older()));
      parts.unlock.addEventListener("click", () => void ask(link.unlock()));
      parts.newer.addEventListener("click", () => {
        parts.scroll.scrollTo({
          top: parts.scroll.scrollHeight,
          behavior: "smooth",
        });
      });
      parts.scroll.addEventListener("scroll", () => {
        const s = parts.scroll;
        pinned = atBottom(s.scrollTop, s.scrollHeight, s.clientHeight);
        if (pinned) attr(parts.newer, "data-show", null);
      });
      parts.box.addEventListener("input", onInput);
      const watch = new ResizeObserver(() => measure());
      for (const e of [parts.inner, parts.footer, parts.head, parts.banner])
        watch.observe(e);
      stops.push(() => watch.disconnect());
      stops.push(link.onView(apply));
      void ask(arg ? link.open(arg) : link.list());
      parts.box.focus();
    },
    unmount() {
      for (const stop of stops.splice(0)) stop();
      if (!closed) {
        closed = true;
        void link.close(false).catch(() => {});
      }
      p?.root.remove();
      p = null;
      drawn = [];
      drawnFor = undefined;
    },
    key: handle,
    onResize: (cb) => void resized.push(cb),
    onClose: (cb) => void closers.push(cb),
  };
}

registerPanel("chat", (arg) => chatPanel(tauriChat, arg));
