// What a note's markdown looks like on screen (components/notes/preview.ts draws it): headings big,
// **bold** bold, lists with bullets, links as links. The marks themselves (# ** ` [](…)) show, faint,
// only on the lines you're on, and are hidden everywhere else, so a note reads as what it says and
// stays plain markdown underneath, for Pip and for history. With the Markdown button on they show
// everywhere, as they did before. It reads CodeMirror's markdown syntax tree, so it's tested here.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

export type Look =
  /** A class for the whole line that starts at `at`. */
  | { kind: "line"; at: number; cls: string }
  /** A class for a span, and where it goes for a link. */
  | { kind: "mark"; from: number; to: number; cls: string; href?: string }
  /** A mark hidden: its line isn't being edited. */
  | { kind: "hide"; from: number; to: number }
  /** A list's "-" drawn as a bullet, which changes shape as lists nest. */
  | { kind: "bullet"; from: number; to: number; depth: number }
  /** A "---" drawn as a rule. */
  | { kind: "rule"; from: number; to: number };

export interface PreviewOptions {
  /** Hide marks off the lines in `active`. False shows them everywhere, faint (the Markdown button). */
  hide: boolean;
  /** The numbers of the lines with a caret or a selection on them. */
  active: ReadonlySet<number>;
}

const HEADINGS: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h3",
  ATXHeading5: "cm-md-h3",
  ATXHeading6: "cm-md-h3",
};
const SPANS: Record<string, string> = {
  StrongEmphasis: "cm-md-strong",
  Emphasis: "cm-md-em",
  InlineCode: "cm-md-code",
  Strikethrough: "cm-md-strike",
};
/** Marks inside a line's text, hidden off the caret's lines. */
const INLINE_MARKS = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark"]);
const LINKS = new Set(["Link", "Image", "Autolink"]);
/** Where a link may go when it's opened from a note: the web, mail, and Nook's own files. */
const OPENS = /^(?:https?:\/\/|mailto:|\/api\/files\/)/i;
const CHIP = /<m-ref\s[^>]*>[\s\S]*?<\/m-ref>/g;

/** The lines with a caret or a selection on them; none while you aren't in the editor. */
export function activeLines(state: EditorState, focused: boolean): Set<number> {
  const lines = new Set<number>();
  if (!focused) return lines;
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) lines.add(n);
  }
  return lines;
}

/** How the lines from `from` to `to` look. */
export function lookOf(state: EditorState, from: number, to: number, opts: PreviewOptions): Look[] {
  const doc = state.doc;
  const start = doc.lineAt(from).from;
  const end = doc.lineAt(to).to;
  const out: Look[] = [];
  // Mentions (<m-ref …>label</m-ref>) are drawn as chips by DocEditor; nothing inside one is styled.
  const chips = [...doc.sliceString(start, end).matchAll(CHIP)].map((m): [number, number] => [
    start + m.index,
    start + m.index + m[0].length,
  ]);
  const inChip = (pos: number) => chips.some(([a, b]) => pos >= a && pos < b);
  const shown = (pos: number) => !opts.hide || opts.active.has(doc.lineAt(pos).number);
  const faint = (a: number, b: number) => {
    out.push({ kind: "mark", from: a, to: b, cls: "cm-md-marker" });
  };
  const mark = (a: number, b: number) => {
    if (shown(a)) faint(a, b);
    else out.push({ kind: "hide", from: a, to: b });
  };
  /** A mark and the space after it, as "# " and "> " are written. */
  const withSpace = (n: SyntaxNode) => (doc.sliceString(n.to, n.to + 1) === " " ? n.to + 1 : n.to);
  const eachLine = (n: SyntaxNode, cls: string) => {
    for (let pos = Math.max(n.from, start); pos <= Math.min(n.to, end); ) {
      const line = doc.lineAt(pos);
      out.push({ kind: "line", at: line.from, cls });
      pos = line.to + 1;
    }
  };

  syntaxTree(state).iterate({
    from: start,
    to: end,
    enter(ref) {
      const n = ref.node;
      if (inChip(n.from)) return false;
      const parent = n.parent?.name ?? "";
      switch (n.name) {
        case "HeaderMark":
          // A setext heading's underline (=== or ---) isn't drawn as a heading: shown as it is.
          if (HEADINGS[parent]) mark(n.from, withSpace(n));
          else faint(n.from, n.to);
          return;
        case "QuoteMark":
          mark(n.from, withSpace(n));
          return;
        case "Blockquote":
          eachLine(n, "cm-md-quote");
          return;
        case "FencedCode":
          eachLine(n, "cm-md-codeblock");
          return;
        // A table is drawn as a grid off its lines (noteBlocks.ts); on them it's its markdown,
        // in even letters, its pipes faint.
        case "Table":
          eachLine(n, "cm-md-table");
          return;
        case "TableDelimiter":
          faint(n.from, n.to);
          return false;
        case "CodeInfo":
          faint(n.from, n.to);
          return;
        case "ListMark":
          listMark(n);
          return;
        case "HorizontalRule":
          if (shown(n.from)) faint(n.from, n.to);
          else out.push({ kind: "rule", from: n.from, to: n.to });
          return;
        case "URL":
          if (!LINKS.has(parent)) link(n.from, n.to, doc.sliceString(n.from, n.to));
          return;
      }
      if (HEADINGS[n.name])
        out.push({ kind: "line", at: doc.lineAt(n.from).from, cls: HEADINGS[n.name]! });
      else if (SPANS[n.name])
        out.push({ kind: "mark", from: n.from, to: n.to, cls: SPANS[n.name]! });
      // A code block's fences stay, faint, so the block can be found and ended.
      else if (INLINE_MARKS.has(n.name)) {
        if (parent === "FencedCode") faint(n.from, n.to);
        else mark(n.from, n.to);
      } else if (n.name === "Link" || n.name === "Autolink") linked(n);
      // A picture shows as written, faint, where it isn't drawn (noteBlocks.ts says where it is).
      else if (n.name === "Image") {
        faint(n.from, n.to);
        return false;
      }
    },
  });
  return out;

  function link(a: number, b: number, href: string) {
    out.push({
      kind: "mark",
      from: a,
      to: b,
      cls: "cm-md-link",
      ...(OPENS.test(href) ? { href } : {}),
    });
  }

  /** [text](url) shows as the text, a link; <url> as the url. */
  function linked(n: SyntaxNode) {
    const marks = n.getChildren("LinkMark");
    const url = n.getChild("URL");
    const href = url ? doc.sliceString(url.from, url.to) : "";
    if (n.name === "Autolink") {
      for (const m of marks) mark(m.from, m.to);
      if (url) link(url.from, url.to, href);
      return;
    }
    const open = marks[0];
    const close = marks.find((m) => doc.sliceString(m.from, m.to) === "]");
    if (!open || !close) return;
    if (close.from > open.to) link(open.to, close.from, href);
    mark(open.from, open.to);
    // "](url)", or "][ref]" for a link written by reference.
    mark(close.from, n.to);
  }

  /** A bullet list's "-" becomes a bullet; a checklist's "- " goes, leaving its box; 1. stays. */
  function listMark(n: SyntaxNode) {
    const list = n.parent?.parent;
    if (list?.name === "OrderedList") {
      out.push({ kind: "mark", from: n.from, to: n.to, cls: "cm-md-ordinal" });
      return;
    }
    if (shown(n.from)) return faint(n.from, n.to);
    if (n.nextSibling?.name === "Task") {
      out.push({ kind: "hide", from: n.from, to: withSpace(n) });
      return;
    }
    let depth = 0;
    for (let p = list?.parent; p; p = p.parent) if (p.name === "BulletList") depth++;
    out.push({ kind: "bullet", from: n.from, to: n.to, depth });
  }
}
