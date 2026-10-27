import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { activeLines, type Look, lookOf } from "./notePreview.ts";

const stateOf = (doc: string, sel?: EditorSelection) => {
  const state = EditorState.create({
    doc,
    ...(sel ? { selection: sel } : {}),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
};
/** The note as it looks with the caret on these lines (none: you're not in it). */
const look = (doc: string, active: number[] = [], hide = true) =>
  lookOf(stateOf(doc), 0, doc.length, { hide, active: new Set(active) });
const text = (doc: string, l: Look) => ("at" in l ? "" : doc.slice(l.from, l.to));
const hidden = (doc: string, active: number[] = []) =>
  look(doc, active)
    .filter((l) => l.kind === "hide")
    .map((l) => text(doc, l));
const marked = (doc: string, cls: string) =>
  look(doc)
    .filter((l) => l.kind === "mark" && l.cls === cls)
    .map((l) => text(doc, l));

describe("lookOf", () => {
  it("hides a heading's #s off its line and shows them, faint, on it", () => {
    expect(hidden("# Plan")).toEqual(["# "]);
    expect(look("# Plan")).toContainEqual({ kind: "line", at: 0, cls: "cm-md-h1" });
    expect(hidden("# Plan", [1])).toEqual([]);
    expect(look("# Plan", [1])).toContainEqual({
      kind: "mark",
      from: 0,
      to: 2,
      cls: "cm-md-marker",
    });
  });

  it("styles bold, italic, code and strike, and hides their marks", () => {
    const doc = "a **b** _c_ `d` ~~e~~";
    expect(hidden(doc)).toEqual(["**", "**", "_", "_", "`", "`", "~~", "~~"]);
    expect(marked(doc, "cm-md-strong")).toEqual(["**b**"]);
    expect(marked(doc, "cm-md-em")).toEqual(["_c_"]);
    expect(marked(doc, "cm-md-code")).toEqual(["`d`"]);
    expect(marked(doc, "cm-md-strike")).toEqual(["~~e~~"]);
    expect(marked("snake_case_name", "cm-md-em")).toEqual([]);
  });

  it("shows a link as its words, going where it says, only to the web, mail or a file", () => {
    const doc = "see [the site](https://example.com) now";
    expect(hidden(doc)).toEqual(["[", "](https://example.com)"]);
    expect(look(doc)).toContainEqual({
      kind: "mark",
      from: 5,
      to: 13,
      cls: "cm-md-link",
      href: "https://example.com",
    });
    const bad = look("[x](javascript:alert(1))").find(
      (l) => l.kind === "mark" && l.cls === "cm-md-link",
    );
    expect(bad && "href" in bad ? bad.href : undefined).toBeUndefined();
    expect(marked("go to https://example.com today", "cm-md-link")).toEqual([
      "https://example.com",
    ]);
  });

  it("draws bullets, nests them, hides a checklist's dash and keeps numbers", () => {
    const doc = "- one\n  - two\n- [ ] box\n1. first";
    const bullets = look(doc).filter((l) => l.kind === "bullet");
    expect(bullets.map((l) => ("depth" in l ? l.depth : -1))).toEqual([0, 1]);
    expect(hidden(doc)).toEqual(["- "]);
    expect(marked(doc, "cm-md-ordinal")).toEqual(["1."]);
    // On its own line the dash shows, faint, to be edited.
    expect(look("- one", [1]).some((l) => l.kind === "bullet")).toBe(false);
  });

  it("draws quotes, code blocks and rules", () => {
    expect(hidden("> said")).toEqual(["> "]);
    expect(look("> said")).toContainEqual({ kind: "line", at: 0, cls: "cm-md-quote" });
    const code = "```js\nlet **x**\n```";
    expect(hidden(code)).toEqual([]);
    expect(look(code).filter((l) => l.kind === "line")).toHaveLength(3);
    expect(look("a\n\n---").some((l) => l.kind === "rule")).toBe(true);
    expect(look("a\n\n---", [3]).some((l) => l.kind === "rule")).toBe(false);
  });

  it("writes a table's lines in even letters, its pipes faint", () => {
    const doc = "| a | **b** |\n| --- | --- |\n| c | d |";
    expect(look(doc).filter((l) => l.kind === "line")).toHaveLength(3);
    expect(marked(doc, "cm-md-marker")).toContain("| --- | --- |");
    expect(marked(doc, "cm-md-strong")).toEqual(["**b**"]);
  });

  it("leaves what's inside a mention chip alone", () => {
    const doc = 'pay <m-ref type="task" id="1">rent *now*</m-ref> and *this*';
    expect(marked(doc, "cm-md-em")).toEqual(["*this*"]);
  });

  it("with the Markdown button on, hides nothing and shows every mark faint", () => {
    const doc = "# Plan\n**b** and - [x](https://a.b)";
    expect(look(doc, [], false).filter((l) => l.kind === "hide")).toEqual([]);
    expect(
      look(doc, [], false).filter((l) => l.kind === "mark" && l.cls === "cm-md-marker"),
    ).not.toEqual([]);
  });
});

describe("activeLines", () => {
  it("is every line a selection touches, and none while the editor isn't focused", () => {
    const state = stateOf("a\nb\nc", EditorSelection.create([EditorSelection.range(0, 3)]));
    expect([...activeLines(state, true)]).toEqual([1, 2]);
    expect([...activeLines(state, false)]).toEqual([]);
  });
});
