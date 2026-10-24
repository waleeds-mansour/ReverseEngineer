import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { kindOf, makeLink, setLineKind, toggleMark } from "./noteFormat.ts";

/** A note with `|` where the caret is, or else `[` `]` around what's selected. */
const stateOf = (marked: string) => {
  const caret = marked.indexOf("|");
  if (caret >= 0)
    return EditorState.create({
      doc: marked.replace("|", ""),
      selection: EditorSelection.cursor(caret),
    });
  const from = marked.indexOf("[");
  const to = marked.indexOf("]", from);
  const doc = marked.slice(0, from) + marked.slice(from + 1, to) + marked.slice(to + 1);
  return EditorState.create({ doc, selection: EditorSelection.range(from, to - 1) });
};
const show = (s: EditorState) => {
  const { from, to } = s.selection.main;
  const d = s.doc.toString();
  return from === to
    ? `${d.slice(0, from)}|${d.slice(from)}`
    : `${d.slice(0, from)}[${d.slice(from, to)}]${d.slice(to)}`;
};
const run = (marked: string, f: (s: EditorState) => TransactionSpec) => {
  const s = stateOf(marked);
  return show(s.update(f(s)).state);
};

describe("toggleMark", () => {
  it("puts marks around what's selected and takes them off again", () => {
    expect(run("the [lease]", (s) => toggleMark(s, "**"))).toBe("the **[lease]**");
    expect(run("the **[lease]**", (s) => toggleMark(s, "**"))).toBe("the [lease]");
    expect(run("the [**lease**]", (s) => toggleMark(s, "**"))).toBe("the [lease]");
    expect(run("a [b] c", (s) => toggleMark(s, "~~"))).toBe("a ~~[b]~~ c");
  });

  it("works on the word at the caret, or opens a pair to type in", () => {
    expect(run("the le|ase", (s) => toggleMark(s, "**"))).toBe("the **le|ase**");
    expect(run("the **le|ase**", (s) => toggleMark(s, "**"))).toBe("the le|ase");
    expect(run("the |", (s) => toggleMark(s, "`"))).toBe("the `|`");
  });

  it("tells italic from bold", () => {
    expect(run("**[x]**", (s) => toggleMark(s, "*"))).toBe("***[x]***");
    expect(run("***[x]***", (s) => toggleMark(s, "*"))).toBe("**[x]**");
    expect(run("_[x]_", (s) => toggleMark(s, "*"))).toBe("[x]");
    expect(run("[**x**]", (s) => toggleMark(s, "*"))).toBe("*[**x**]*");
  });

  it("marks each line of a selection inside its heading or list marker", () => {
    expect(run("# [one\n- two]", (s) => toggleMark(s, "**"))).toBe("# **[one**\n- **two]**");
  });
});

describe("setLineKind", () => {
  it("turns lines into headings, lists and quotes, and back", () => {
    expect(run("Pl|an", (s) => setLineKind(s, "h1"))).toBe("# Pl|an");
    expect(run("# Pl|an", (s) => setLineKind(s, "h1"))).toBe("Pl|an");
    expect(run("- it|em", (s) => setLineKind(s, "h2"))).toBe("## it|em");
    expect(run("|said", (s) => setLineKind(s, "quote"))).toBe("> |said");
    expect(run("  - |x", (s) => setLineKind(s, "check"))).toBe("  - [ ] |x");
  });

  it("numbers the lines it makes a numbered list", () => {
    expect(run("[a\nb]", (s) => setLineKind(s, "number"))).toBe("1. [a\n2. b]");
  });

  it("knows what a line is", () => {
    expect(["# a", "### a", "> a", "- [x] a", "* a", "3. a", "a"].map(kindOf)).toEqual([
      "h1",
      "h3",
      "quote",
      "check",
      "bullet",
      "number",
      "text",
    ]);
  });
});

describe("makeLink", () => {
  it("makes what's selected a link, with the caret where its address goes", () => {
    expect(run("see [site]", makeLink)).toBe("see [site](|)");
    expect(run("see |", makeLink)).toBe("see [|]()");
  });
});
