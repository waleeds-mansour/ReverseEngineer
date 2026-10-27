import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { alignOf, NEW_TABLE, splitRow, tableEnter, tableLines, tableMove } from "./noteTable.ts";

/** A note with the caret where `^` is. */
const stateOf = (marked: string) => {
  const at = marked.indexOf("^");
  const doc = marked.replace("^", "");
  const state = EditorState.create({
    doc,
    selection: { anchor: at < 0 ? 0 : at },
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
};
/** The note after a key, with `^` where the caret ends up. */
const after = (state: EditorState, spec: TransactionSpec | null) => {
  if (!spec) return null;
  const next = state.update(spec).state;
  const at = next.selection.main.head;
  return `${next.doc.sliceString(0, at)}^${next.doc.sliceString(at)}`;
};
const cells = (text: string) => splitRow(text).map((s) => text.slice(s.from, s.to));

describe("splitRow", () => {
  it("splits on pipes, with or without them at the ends, and keeps an escaped one", () => {
    expect(cells("| Name | Qty |")).toEqual(["Name", "Qty"]);
    expect(cells("a | b")).toEqual(["a", "b"]);
    expect(cells("| a \\| b | **2** |")).toEqual(["a \\| b", "**2**"]);
    expect(cells("| --- | :-: |")).toEqual(["---", ":-:"]);
  });

  it("puts an empty cell's caret inside its spaces", () => {
    const [a, b] = splitRow("|  |  |");
    expect(a).toEqual({ from: 2, to: 2, end: 3 });
    expect(b).toEqual({ from: 5, to: 5, end: 6 });
  });
});

describe("alignOf", () => {
  it("reads left, centre and right from the line under the header", () => {
    expect(alignOf("| :-- | :-: | --: | --- |")).toEqual(["left", "center", "right", null]);
  });
});

const TABLE = "Plan\n\n| Name | Qty |\n| --- | --- |\n| eggs | 6 |\n| milk | 1 |\n\nafter";

describe("tableLines", () => {
  it("finds the table the caret is in, and nothing outside one", () => {
    expect(tableLines(stateOf(TABLE.replace("eggs", "eg^gs")), 0)).toBeNull();
    const s = stateOf(TABLE.replace("eggs", "eg^gs"));
    expect(tableLines(s, s.selection.main.head)).toEqual({ first: 3, last: 6 });
    const end = stateOf(TABLE.replace("| 1 |", "| 1 |^"));
    expect(tableLines(end, end.selection.main.head)).toEqual({ first: 3, last: 6 });
    const out = stateOf(TABLE.replace("after", "af^ter"));
    expect(tableLines(out, out.selection.main.head)).toBeNull();
  });
});

describe("tableMove", () => {
  it("Tab goes to the end of the next cell, over the line under the header", () => {
    const s = stateOf(TABLE.replace("Name", "Na^me"));
    expect(after(s, tableMove(s, 1))).toContain("| Qty^ |");
    const q = stateOf(TABLE.replace("Qty", "Q^ty"));
    expect(after(q, tableMove(q, 1))).toContain("| eggs^ | 6 |");
  });

  it("Shift+Tab goes back, and stays put in the first cell", () => {
    const s = stateOf(TABLE.replace("| eggs", "| e^ggs"));
    expect(after(s, tableMove(s, -1))).toContain("| Qty^ |");
    const first = stateOf(TABLE.replace("Name", "^Name"));
    expect(after(first, tableMove(first, -1))).toContain("| Name^ |");
  });

  it("Tab in the last cell adds a row", () => {
    const s = stateOf(TABLE.replace("| 1 |", "| 1^ |"));
    expect(after(s, tableMove(s, 1))).toContain("| milk | 1 |\n| ^ |  |\n\nafter");
  });

  it("does nothing outside a table, so Tab keeps its usual job", () => {
    const s = stateOf(TABLE.replace("Plan", "Pl^an"));
    expect(tableMove(s, 1)).toBeNull();
  });
});

describe("tableEnter", () => {
  it("adds a row under the one you're in, with the caret in its first cell", () => {
    const s = stateOf(TABLE.replace("| 1 |", "| 1^ |"));
    expect(after(s, tableEnter(s))).toContain("| milk | 1 |\n| ^ |  |\n");
    const head = stateOf(TABLE.replace("Qty", "Qty^"));
    expect(after(head, tableEnter(head))).toContain("| --- | --- |\n| ^ |  |\n| eggs");
  });

  it("on an empty last row, leaves the table, a blank line under it", () => {
    const s = stateOf(TABLE.replace("| milk | 1 |", "| milk | 1 |\n| ^ |  |"));
    expect(after(s, tableEnter(s))).toContain("| milk | 1 |\n\n^\n\nafter");
  });

  it("does nothing outside a table, or after a row's closing pipe (a table typed by hand)", () => {
    const s = stateOf(TABLE.replace("after", "after^"));
    expect(tableEnter(s)).toBeNull();
    const typed = stateOf(TABLE.replace("| 6 |", "| 6 |^"));
    expect(tableEnter(typed)).toBeNull();
  });
});

describe("NEW_TABLE", () => {
  it("is a table to markdown, and Tab moves through its empty cells", () => {
    const s = stateOf(`^${NEW_TABLE.text}`);
    expect(tableLines(s, 0)).toEqual({ first: 1, last: 3 });
    const moved = s.update({ selection: { anchor: NEW_TABLE.caret } }).state;
    expect(after(moved, tableMove(moved, 1))).toBe("|  | ^ |\n| --- | --- |\n|  |  |");
  });
});
