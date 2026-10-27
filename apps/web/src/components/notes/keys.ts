// A note's formatting keys, the ones Google Docs and Notion use: Ctrl+B, I, E and Shift+X for bold,
// italic, code and strike; Ctrl+Alt+1 to 3 for headings (0 for text); Ctrl+Shift+7, 8 and 9 for
// numbered, bulleted and checklists; Ctrl+/ shows the markdown. Ctrl+K stays Nook's search. In a
// table, Tab and Shift+Tab go cell to cell and Enter adds a row (lib/noteTable.ts).

import { type EditorState, Prec, type TransactionSpec } from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";
import { type LineKind, setLineKind, toggleMark } from "../../lib/noteFormat.ts";
import { toggleMarks } from "../../lib/noteMarks.ts";
import { tableEnter, tableMove } from "../../lib/noteTable.ts";

const run =
  (f: (s: EditorState) => TransactionSpec): Command =>
  (view) => {
    if (view.state.readOnly) return false;
    view.dispatch(f(view.state));
    return true;
  };
const kind = (k: LineKind) => run((s) => setLineKind(s, k));
/** A key that does something only in a table; anywhere else it does what it always does. */
const inTable =
  (f: (s: EditorState) => TransactionSpec | null): Command =>
  (view) => {
    const spec = view.state.readOnly ? null : f(view.state);
    if (spec) view.dispatch(spec);
    return spec !== null;
  };

export const noteKeys = Prec.high(
  keymap.of([
    { key: "Mod-b", run: run((s) => toggleMark(s, "**")) },
    { key: "Mod-i", run: run((s) => toggleMark(s, "*")) },
    { key: "Mod-e", run: run((s) => toggleMark(s, "`")) },
    { key: "Mod-Shift-x", run: run((s) => toggleMark(s, "~~")) },
    { key: "Mod-Alt-0", run: kind("text") },
    { key: "Mod-Alt-1", run: kind("h1") },
    { key: "Mod-Alt-2", run: kind("h2") },
    { key: "Mod-Alt-3", run: kind("h3") },
    { key: "Mod-Shift-7", run: kind("number") },
    { key: "Mod-Shift-8", run: kind("bullet") },
    { key: "Mod-Shift-9", run: kind("check") },
    { key: "Tab", run: inTable((s) => tableMove(s, 1)) },
    { key: "Shift-Tab", run: inTable((s) => tableMove(s, -1)) },
    { key: "Enter", run: inTable(tableEnter) },
    {
      key: "Mod-/",
      run: () => {
        toggleMarks();
        return true;
      },
    },
  ]),
);
