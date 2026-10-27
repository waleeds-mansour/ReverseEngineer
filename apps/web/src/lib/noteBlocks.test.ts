import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { type Block, blocksOf, cellText } from "./noteBlocks.ts";

const stateOf = (doc: string) => {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, doc.length, 5000);
  return state;
};
/** What's drawn, with the caret on these lines (none: you're not in the note). */
const blocks = (doc: string, active: number[] = [], hide = true) =>
  blocksOf(stateOf(doc), { hide, active: new Set(active) });
const kinds = (doc: string, active: number[] = []) =>
  blocks(doc, active).map((b) => `${b.kind}:${doc.slice(b.from, b.to)}`);

const FILE = "/api/files/0b6f8f0e-8a4e-4b9e-9c1e-3f2a7d1c5e90";

describe("blocksOf: pictures", () => {
  it("draws a picture Nook keeps, taking its line when it's all the line says", () => {
    const doc = `Trip\n![beach.png](${FILE})\nafter`;
    expect(blocks(doc)).toEqual([
      {
        kind: "picture",
        from: 5,
        to: 5 + doc.split("\n")[1]!.length,
        src: FILE,
        alt: "beach.png",
        whole: true,
      },
    ]);
  });

  it("draws one among words in the line, not taking it", () => {
    const [b] = blocks(`see ![map](${FILE}) here`);
    expect(b).toMatchObject({ kind: "picture", whole: false, alt: "map" });
  });

  it("shows it as written while the caret is on its line", () => {
    expect(blocks(`a\n![x](${FILE})`, [2])).toEqual([]);
    expect(blocks(`a\n![x](${FILE})`, [1])).toHaveLength(1);
  });

  it("draws a picture from elsewhere on the web as a card, and leaves a relative one as written", () => {
    expect(blocks("![logo](https://example.com/logo.png)")).toEqual([
      {
        kind: "card",
        from: 0,
        to: 37,
        url: "https://example.com/logo.png",
        label: "logo",
      },
    ]);
    expect(blocks("![x](pics/x.png)")).toEqual([]);
    expect(blocks("![x](javascript:alert(1))")).toEqual([]);
  });
});

describe("blocksOf: tables", () => {
  const TABLE = "Plan\n\n| Name | Qty |\n| :-- | --: |\n| **eggs** | 6 |\n| milk |";

  it("draws a table as a grid of what its cells say, lined up as written", () => {
    const [grid] = blocks(TABLE) as Extract<Block, { kind: "grid" }>[];
    expect(grid).toMatchObject({
      kind: "grid",
      from: 6,
      to: TABLE.length,
      align: ["left", "right"],
    });
    expect(grid!.rows.map((r) => r.map((c) => c.text))).toEqual([
      ["Name", "Qty"],
      ["eggs", "6"],
      ["milk", ""],
    ]);
  });

  it("knows where each cell's words end, to put the caret there from a click", () => {
    const [grid] = blocks(TABLE) as Extract<Block, { kind: "grid" }>[];
    const start = grid!.from;
    expect(TABLE.slice(start, start + grid!.rows[1]![0]!.at)).toMatch(/\*\*eggs\*\*$/);
    // A cell the row leaves out: the caret goes to the row's end.
    expect(start + grid!.rows[2]![1]!.at).toBe(TABLE.length);
  });

  it("shows the whole table as written while the caret is on any of its lines", () => {
    expect(kinds(TABLE, [5])).toEqual([]);
    expect(kinds(TABLE, [1])).toHaveLength(1);
  });
});

describe("blocksOf: link cards", () => {
  it("draws a line that's only a web address as a card", () => {
    expect(blocks("https://example.com/a?b=1")).toEqual([
      { kind: "card", from: 0, to: 25, url: "https://example.com/a?b=1", label: "" },
    ]);
    expect(blocks("<https://example.com>")).toMatchObject([
      { kind: "card", url: "https://example.com" },
    ]);
    expect(blocks("  https://example.com  ")).toMatchObject([{ kind: "card", from: 2, to: 21 }]);
  });

  it("leaves links among words, in a list, in [words](url) or not on the web as they are", () => {
    expect(blocks("see https://example.com today")).toEqual([]);
    expect(blocks("- https://example.com")).toEqual([]);
    expect(blocks("[the site](https://example.com)")).toEqual([]);
    expect(blocks("www.example.com")).toEqual([]);
    expect(blocks("```\nhttps://example.com\n```")).toEqual([]);
  });

  it("shows the address as written while the caret is on it", () => {
    expect(blocks("https://example.com", [1])).toEqual([]);
  });
});

describe("blocksOf: the Markdown button", () => {
  it("draws nothing with every mark showing", () => {
    const doc = `![x](${FILE})\n\nhttps://example.com\n\n| a |\n| - |\n| b |`;
    expect(blocks(doc)).toHaveLength(3);
    expect(blocks(doc, [], false)).toEqual([]);
  });
});

describe("cellText", () => {
  it("reads a cell as its words: marks, links and mentions as they show", () => {
    expect(cellText("**eggs** and _milk_")).toBe("eggs and milk");
    expect(cellText("[the site](https://a.b) \\| `x`")).toBe("the site | x");
    expect(cellText('<m-ref type="task" id="1">Pay &amp; go</m-ref>')).toBe("@Pay & go");
    expect(cellText("snake_case_name")).toBe("snake_case_name");
  });
});
