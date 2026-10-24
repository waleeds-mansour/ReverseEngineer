// Formatting a note from the keyboard, the selection toolbar or the / menu. Bold and the rest put
// markdown's marks around what's selected, or take them off again; Turn into sets what a line is
// (a heading, a list, a quote). The note stays markdown: these write only what a person would type.

import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";

export type InlineMark = "**" | "*" | "~~" | "`";
export type LineKind = "text" | "h1" | "h2" | "h3" | "bullet" | "number" | "check" | "quote";

const PREFIX: Record<Exclude<LineKind, "number">, string> = {
  text: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  bullet: "- ",
  check: "- [ ] ",
  quote: "> ",
};
/** What a line starts with now, after its indent: a heading's #s, a quote's >, a list's marker. */
const BLOCK = /^(\s*)(#{1,6} |> |(?:[-*+]|\d{1,4}[.)]) (?:\[[ xX]\] )?)?/;

/** What kind of line this is. */
export function kindOf(text: string): LineKind {
  const pre = BLOCK.exec(text)?.[2] ?? "";
  if (pre.startsWith("#")) return pre.length === 2 ? "h1" : pre.length === 3 ? "h2" : "h3";
  if (pre === "> ") return "quote";
  if (pre.includes("[")) return "check";
  if (/^[-*+]/.test(pre)) return "bullet";
  return pre ? "number" : "text";
}

/** The lines a selection touches. One ending at the very start of a line leaves that line out. */
function linesOf(state: EditorState, r: SelectionRange): Line[] {
  const first = state.doc.lineAt(r.from).number;
  let last = state.doc.lineAt(r.to).number;
  if (r.to > r.from && r.to === state.doc.line(last).from) last--;
  const out: Line[] = [];
  for (let n = first; n <= Math.max(first, last); n++) out.push(state.doc.line(n));
  return out;
}

/**
 * Each selected line made `kind`. A key toggles: if every one already is, they go back to text.
 * Turn into doesn't (`toggle` false): picking what a line is leaves it that.
 */
export function setLineKind(state: EditorState, kind: LineKind, toggle = true): TransactionSpec {
  const lines = new Map<number, Line>();
  for (const r of state.selection.ranges) for (const l of linesOf(state, r)) lines.set(l.number, l);
  const sorted = [...lines.values()].sort((a, b) => a.from - b.from);
  const all = kind !== "text" && sorted.every((l) => kindOf(l.text) === kind);
  const target = toggle && all ? "text" : kind;
  let n = 0;
  const changes = state.changes(
    sorted.map((l) => {
      const m = BLOCK.exec(l.text)!;
      const indent = m[1] ?? "";
      const pre = target === "number" ? `${++n}. ` : PREFIX[target];
      // Headings and quotes start at the edge; a list keeps its indent, so it stays nested.
      const keep = target.startsWith("h") || target === "quote" ? "" : indent;
      return { from: l.from, to: l.from + indent.length + (m[2]?.length ?? 0), insert: keep + pre };
    }),
  );
  return {
    changes,
    selection: state.selection.map(changes, 1),
    scrollIntoView: true,
    userEvent: "input.format",
  };
}

/** How many of `c` there are in a row next to `pos`, looking back (-1) or ahead (1), up to 3. */
function run(state: EditorState, pos: number, dir: -1 | 1, c: string): number {
  let n = 0;
  while (n < 3) {
    const at = dir < 0 ? pos - n - 1 : pos + n;
    if (at < 0 || at >= state.doc.length || state.sliceDoc(at, at + 1) !== c) break;
    n++;
  }
  return n;
}

/** The mark already around from–to: "*" counts _ too, and * in *** but not in ** (that's bold). */
function around(state: EditorState, from: number, to: number, mark: InlineMark): string | null {
  const both = (c: string) => Math.min(run(state, from, -1, c), run(state, to, 1, c));
  if (mark === "*") {
    const stars = both("*");
    if (stars === 1 || stars === 3) return "*";
    return both("_") === 1 ? "_" : null;
  }
  return both(mark[0]!) >= mark.length ? mark : null;
}

/** The part of each line from–to covers, without a line's own # or - [ ] (marks go inside those). */
function pieces(state: EditorState, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (const l of linesOf(state, EditorSelection.range(from, to))) {
    const pre = BLOCK.exec(l.text)?.[0].length ?? 0;
    const a = Math.max(from, l.from + pre);
    const b = Math.min(to, l.to);
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** Bold, italic, strike or code on what's selected (the word at the caret if nothing is), or off. */
export function toggleMark(state: EditorState, mark: InlineMark): TransactionSpec {
  return state.changeByRange((range) => {
    let { from, to } = range;
    if (range.empty) {
      const word = state.wordAt(from);
      if (!word) {
        const insert = mark + mark;
        return { changes: { from, insert }, range: EditorSelection.cursor(from + mark.length) };
      }
      ({ from, to } = word);
    }
    const parts = pieces(state, from, to);
    const found = parts.map(([a, b]) => around(state, a, b, mark));
    const off = parts.length > 0 && found.every((m) => m !== null);
    // The marks selected along with the words: **bold** selected, Bold takes them off.
    const L = mark.length;
    const inside =
      !off &&
      parts.length > 0 &&
      parts.every(([a, b]) => {
        const t = state.sliceDoc(a, b);
        const bold = mark === "*" && t.startsWith("**") && !t.startsWith("***");
        return t.length > 2 * L && t.startsWith(mark) && t.endsWith(mark) && !bold;
      });
    const changes = state.changes(
      parts.flatMap(([a, b], i): ChangeSpec[] => {
        if (off)
          return [
            { from: a - found[i]!.length, to: a },
            { from: b, to: b + found[i]!.length },
          ];
        if (inside)
          return [
            { from: a, to: a + L },
            { from: b - L, to: b },
          ];
        return [
          { from: a, insert: mark },
          { from: b, insert: mark },
        ];
      }),
    );
    const next = range.empty
      ? EditorSelection.cursor(changes.mapPos(range.from, off ? -1 : 1))
      : EditorSelection.range(changes.mapPos(from, 1), changes.mapPos(to, -1));
    return { changes, range: next };
  });
}

/** What's selected made a link, with the caret where its address goes: [text](|). */
export function makeLink(state: EditorState): TransactionSpec {
  return state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    // With nothing selected the caret goes between the brackets, for the link's words first.
    const at = range.from + (text ? insert.length - 1 : 1);
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(at),
    };
  });
}
