// What in a note is drawn as more than words (components/notes/blocks.ts draws it): a picture kept
// in Nook shows as the picture, a table as a grid, and a line that's only a web address as a card
// with the page's title. Like the marks (notePreview.ts), each shows as written while the caret is
// on its lines, to be edited there, and everywhere with the Markdown button on. The note itself
// stays plain markdown. It reads CodeMirror's markdown syntax tree, so it's tested here.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { unescapeText } from "@hearth/core";
import type { PreviewOptions } from "./notePreview.ts";
import { type Align, alignOf, splitRow } from "./noteTable.ts";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** A cell in a grid: what it says, and where the caret goes for it, from the table's start. */
export interface Cell {
  text: string;
  at: number;
}

export type Block =
  /** A picture kept in Nook. `whole`: it's all its line says, so it takes the line. */
  | { kind: "picture"; from: number; to: number; src: string; alt: string; whole: boolean }
  /** A table, its first row the header. */
  | { kind: "grid"; from: number; to: number; rows: Cell[][]; align: Align[] }
  /** A line that's only a web address, or a picture elsewhere on the web (`label` its words). */
  | { kind: "card"; from: number; to: number; url: string; label: string };

/** A file kept in Nook (the server's /api/files). Pictures from anywhere else aren't loaded. */
const OURS = /^\/api\/files\/[0-9a-f-]{36}$/i;
const WEB = /^https?:\/\/[^\s<>"]+$/i;
/** Blocks whose insides are written as they are: nothing in them is drawn. */
const AS_WRITTEN = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "CommentBlock"]);

const onTheWeb = (url: string) => {
  if (!WEB.test(url)) return false;
  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** What's drawn in the note, in order. */
export function blocksOf(state: EditorState, opts: PreviewOptions): Block[] {
  if (!opts.hide) return [];
  const doc = state.doc;
  const out: Block[] = [];
  /** The caret is on one of the lines from `a` to `b`. */
  const editing = (a: number, b: number) => {
    for (let n = doc.lineAt(a).number, last = doc.lineAt(b).number; n <= last; n++)
      if (opts.active.has(n)) return true;
    return false;
  };
  /** The node is all its line says, spaces aside. */
  const alone = (n: SyntaxNode) => doc.lineAt(n.from).text.trim() === doc.sliceString(n.from, n.to);

  syntaxTree(state).iterate({
    enter(ref) {
      const n = ref.node;
      if (AS_WRITTEN.has(n.name)) return false;
      if (n.name === "Table") {
        // Only one that starts its lines: one in a list or a quote stays as written.
        if (n.parent?.name === "Document" && !editing(n.from, n.to)) out.push(grid(n));
        return false;
      }
      if (n.name === "Image") {
        picture(n);
        return false;
      }
      if (n.name === "Autolink" || (n.name === "URL" && n.parent?.name === "Paragraph")) {
        const url = n.name === "URL" ? doc.sliceString(n.from, n.to) : urlOf(n);
        if (alone(n) && onTheWeb(url) && !editing(n.from, n.to))
          out.push({ kind: "card", from: n.from, to: n.to, url, label: "" });
        return false;
      }
    },
  });
  return out;

  function urlOf(n: SyntaxNode) {
    const url = n.getChild("URL");
    return url ? doc.sliceString(url.from, url.to) : "";
  }

  function picture(n: SyntaxNode) {
    if (editing(n.from, n.to)) return;
    const src = urlOf(n);
    const marks = n.getChildren("LinkMark");
    const close = marks.find((m) => doc.sliceString(m.from, m.to) === "]");
    const alt = close ? doc.sliceString(n.from + 2, close.from) : "";
    const whole = alone(n);
    if (OURS.test(src)) out.push({ kind: "picture", from: n.from, to: n.to, src, alt, whole });
    else if (whole && onTheWeb(src))
      out.push({ kind: "card", from: n.from, to: n.to, url: src, label: alt || "Picture" });
  }

  function grid(n: SyntaxNode): Block {
    const first = doc.lineAt(n.from);
    const last = doc.lineAt(n.to);
    const head = splitRow(first.text);
    const rows: Cell[][] = [];
    for (let k = first.number; k <= last.number; k++) {
      if (k === first.number + 1) continue;
      const line = doc.line(k);
      const spans = splitRow(line.text);
      rows.push(
        head.map((_, c) => {
          const s = spans[c];
          // A cell the row leaves out is empty, its caret at the row's end.
          if (!s) return { text: "", at: line.to - first.from };
          return {
            text: cellText(line.text.slice(s.from, s.to)),
            at: line.from + s.to - first.from,
          };
        }),
      );
    }
    const align = alignOf(doc.line(first.number + 1).text);
    return {
      kind: "grid",
      from: first.from,
      to: last.to,
      rows,
      align: head.map((_, c) => align[c] ?? null),
    };
  }
}

/** A cell's markdown read as its words: marks gone, links as their words, mentions as @name. */
export function cellText(md: string): string {
  return md
    .replace(/<m-ref\s[^>]*>([\s\S]*?)<\/m-ref>/g, (_m, label: string) => `@${unescapeText(label)}`)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](\S(?:.*?\S)?)[*_](?![\w*])/g, "$1$2")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, "$1");
}
