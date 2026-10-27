// Tables in a note, written as markdown writes them (GitHub's pipes): where each cell is, and
// moving through them from the keyboard. On a table's lines Tab and Shift+Tab go cell to cell,
// Tab in the last cell adds a row, and Enter adds a row under the one you're on (on an empty last
// row, Enter leaves the table). The note stays a markdown table: these write only what a person
// would type. Off its lines a table is drawn as a grid (noteBlocks.ts).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState, TransactionSpec } from "@codemirror/state";

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

/** A cell on a row's line: its words (`from`, `to`, spaces trimmed) and the pipe that ends it. */
export interface CellSpan {
  from: number;
  to: number;
  end: number;
}
export type Align = "left" | "center" | "right" | null;

/** A new table for the / menu: two columns, a header and one row, the caret in its first cell. */
export const NEW_TABLE = { text: "|  |  |\n| --- | --- |\n|  |  |", caret: 2 };

/** The cells on a row's line, from its start. Pipes split them, but not an escaped one (\|). */
export function splitRow(text: string): CellSpan[] {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") i++;
    else if (text[i] === "|") pipes.push(i);
  }
  const first = text.search(/\S/);
  if (first < 0) return [];
  const last = text.trimEnd().length - 1;
  // A pipe at either end only closes the row; without one, the row's edge does.
  const open = pipes[0] === first ? first : first - 1;
  const close = pipes.at(-1) === last && last > open ? last : last + 1;
  const edges = [open, ...pipes.filter((p) => p > open && p < close), close];
  const out: CellSpan[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i]!;
    const b = edges[i + 1]!;
    const raw = text.slice(a + 1, b);
    const from = a + 1 + (raw.length - raw.trimStart().length);
    const to = b - (raw.length - raw.trimEnd().length);
    // An empty cell's caret goes inside its spaces, so what's typed there reads "| x |".
    const empty = Math.min(a + 2, b);
    out.push(from < to ? { from, to, end: b } : { from: empty, to: empty, end: b });
  }
  return out;
}

/** How each column lines up, from the line under the header (:-- left, :-: centre, --: right). */
export function alignOf(text: string): Align[] {
  return splitRow(text).map((s) => {
    const c = text.slice(s.from, s.to).replace(/\s/g, "");
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

/** The first and last line numbers of the table at `pos`, or null outside one. */
export function tableLines(
  state: EditorState,
  pos: number,
): { first: number; last: number } | null {
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  for (const [at, side] of [
    [line.to, -1],
    [line.from, 1],
  ] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(at, side); n; n = n.parent) {
      if (n.name !== "Table") continue;
      const first = state.doc.lineAt(n.from).number;
      const last = state.doc.lineAt(n.to).number;
      if (line.number >= first && line.number <= last) return { first, last };
    }
  }
  return null;
}

interface Place {
  line: number;
  from: number;
  to: number;
  end: number;
}

/** Every cell in the table, row by row, in the note's positions: not the line under the header. */
function placesIn(state: EditorState, t: { first: number; last: number }): Place[] {
  const out: Place[] = [];
  for (let n = t.first; n <= t.last; n++) {
    if (n === t.first + 1) continue;
    const line = state.doc.line(n);
    for (const s of splitRow(line.text))
      out.push({ line: n, from: line.from + s.from, to: line.from + s.to, end: line.from + s.end });
  }
  return out;
}

/** A new empty row under line `after`, as wide as the header, with the caret in its first cell. */
function addRow(state: EditorState, after: number, t: { first: number }): TransactionSpec {
  const cols = Math.max(1, splitRow(state.doc.line(t.first).text).length);
  const at = state.doc.line(after).to;
  return {
    changes: { from: at, insert: `\n|${"  |".repeat(cols)}` },
    selection: { anchor: at + 3 },
    scrollIntoView: true,
    userEvent: "input",
  };
}

/** Tab (1) or Shift+Tab (-1) in a table: the next or last cell, its caret at the end of its words. */
export function tableMove(state: EditorState, dir: 1 | -1): TransactionSpec | null {
  const head = state.selection.main.head;
  const t = tableLines(state, head);
  if (!t) return null;
  const places = placesIn(state, t);
  if (!places.length) return null;
  const line = state.doc.lineAt(head).number;
  let i: number;
  if (line === t.first + 1) {
    // On the line under the header: between its last cell and the first row's first.
    i = places.findLastIndex((p) => p.line === t.first) + (dir > 0 ? 0 : 1);
  } else {
    const on = places.map((p, k) => [p, k] as const).filter(([p]) => p.line === line);
    i = (on.find(([p]) => head <= p.end) ?? on.at(-1))?.[1] ?? 0;
  }
  const next = i + dir;
  if (next >= places.length) return addRow(state, t.last, t);
  const to = places[Math.max(0, next)]!;
  return { selection: { anchor: to.to }, scrollIntoView: true };
}

/**
 * Enter in a cell: a row under this one (under the header's line, from the header). After a row's
 * closing pipe it's a new line as usual, for a table typed out by hand.
 */
export function tableEnter(state: EditorState): TransactionSpec | null {
  const head = state.selection.main.head;
  const t = tableLines(state, head);
  if (!t) return null;
  const line = state.doc.lineAt(head);
  const cells = splitRow(line.text);
  if (head - line.from > (cells.at(-1)?.end ?? line.length)) return null;
  const blank = cells.every((s) => s.from === s.to);
  // An empty last row: Enter leaves the table, as it leaves an empty list item, a blank line
  // under it (GitHub's markdown reads words right under a table as another row).
  if (line.number === t.last && line.number > t.first + 1 && blank)
    return {
      changes: { from: line.from, to: line.to, insert: "\n" },
      selection: { anchor: line.from + 1 },
      userEvent: "input",
    };
  return addRow(state, Math.max(line.number, t.first + 1), t);
}
