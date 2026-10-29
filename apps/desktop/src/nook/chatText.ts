// What the notch's chat makes of Pip's words before drawing them (chatDraw.ts), with no page of its
// own so it can be tested alone: light markdown (paragraphs, lists, a heading's line, fenced code,
// inline code, bold and links), how long ago a conversation moved, and what a key does. Links are
// only ever shown: a link's words can say anything, so where it goes is shown beside them, and
// nothing here opens one.

export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; text: string }
  /** `host` is shown beside words that aren't the address itself. */
  | { kind: "link"; text: string; url: string; host: string | null };

export type Block =
  | { kind: "para"; lines: Span[][] }
  | { kind: "head"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "code"; text: string };

/** The longest message chat.send takes, in UTF-16 units: the box's maxLength. */
export const SEND_MAX = 20_000;

/**
 * How much of a line is read for inline markdown; the rest is shown as it is. With every pattern
 * below bounded as well, a try from any place is short, so the scan stays linear in the line
 * however its brackets and backticks are piled up.
 */
export const INLINE_MAX = 4_000;
const INLINE =
  /`([^`\n]{1,500})`|\*\*([^*\n]{1,500})\*\*|\[([^\]\n]{1,300})\]\((https?:\/\/[^)\s]{1,2048})\)|(https?:\/\/[^\s<>()]{0,2047}[^\s<>().,;:!?'"])/g;

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A line's spans. */
export function inline(text: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  const plain = (to: number) => {
    if (to > at) out.push({ kind: "text", text: text.slice(at, to) });
  };
  for (const m of text.slice(0, INLINE_MAX).matchAll(INLINE)) {
    const start = m.index ?? 0;
    plain(start);
    const [, code, bold, words, url, bare] = m;
    if (code !== undefined) out.push({ kind: "code", text: code });
    else if (bold !== undefined) out.push({ kind: "bold", text: bold });
    else if (words !== undefined && url !== undefined) {
      const host = words.trim() === url ? null : hostOf(url);
      out.push({ kind: "link", text: words, url, host });
    } else if (bare !== undefined)
      out.push({ kind: "link", text: bare, url: bare, host: null });
    at = start + m[0].length;
  }
  plain(text.length);
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const HEAD = /^\s{0,3}#{1,6}\s+(.*)$/;
const FENCE = /^\s*```/;

type ListBlock = Extract<Block, { kind: "list" }>;

/** Pip's words as blocks: a blank line ends a paragraph, and lines within one stay lines. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let para: Span[][] | null = null;
  let list: ListBlock | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      para = list = null;
      const code: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i] ?? ""); i++)
        code.push(lines[i] ?? "");
      out.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    if (!line.trim()) {
      para = list = null;
      continue;
    }
    const head = HEAD.exec(line);
    if (head) {
      para = list = null;
      out.push({ kind: "head", spans: inline(head[1] ?? "") });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      const ordered = numbered !== null;
      if (list === null || list.ordered !== ordered) {
        list = { kind: "list", ordered, items: [] };
        out.push(list);
      }
      list.items.push(inline(item[1] ?? ""));
      para = null;
      continue;
    }
    list = null;
    if (para === null) {
      para = [];
      out.push({ kind: "para", lines: para });
    }
    para.push(inline(line.trim()));
  }
  return out;
}

/** How long ago, shortly: "now", "5m", "3h", "2d", or "" when not known. */
export function ago(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (!iso || Number.isNaN(at)) return "";
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export type ChatKey =
  "send" | "close_menu" | "menu_up" | "menu_down" | "pick" | null;

/** What a key does: Enter sends and Shift+Enter is a new line (the box's own), Esc closes the
 * switcher when it's open, and otherwise is the notch's, which closes the panel. */
export function chatKey(
  e: { key: string; shiftKey: boolean; isComposing?: boolean },
  menuOpen: boolean,
): ChatKey {
  if (e.isComposing) return null;
  if (menuOpen) {
    if (e.key === "Escape") return "close_menu";
    if (e.key === "ArrowUp") return "menu_up";
    if (e.key === "ArrowDown") return "menu_down";
    if (e.key === "Enter") return "pick";
    return null;
  }
  if (e.key === "Enter" && !e.shiftKey) return "send";
  return null;
}

/** Whether a list scrolled this far is at its newest line, give or take a little. */
export const atBottom = (
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
) => scrollHeight - scrollTop - clientHeight < 40;
