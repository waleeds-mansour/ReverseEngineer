import { describe, expect, it } from "vitest";
import type { Canvas } from "./canvas.ts";
import { mergeCanvas, mergeRecord, mergeText, mergeWorkbook } from "./merge.ts";
import { emptyWorkbook, type Workbook, type Worksheet } from "./sheet.ts";

const card = (id: string, text: string, y = 0) =>
  ({ id, type: "text", text, x: 0, y, width: 200, height: 80 }) as const;
const arrow = (id: string, from: string, to: string): Canvas["edges"][number] => ({
  id,
  from: { type: "connected", node: from, side: "right" },
  to: { type: "connected", node: to, side: "left" },
});

describe("merging a board", () => {
  const base: Canvas = { nodes: [card("a", "Goals"), card("b", "Risks")], edges: [] };

  it("keeps Jarvis's new cards and the edit made at the same time", () => {
    const theirs: Canvas = { ...base, nodes: [...base.nodes, card("j", "From Jarvis", 200)] };
    const mine: Canvas = { ...base, nodes: [card("a", "Goals for Q4"), base.nodes[1]!] };
    const out = mergeCanvas(base, mine, theirs);
    expect(out.nodes.map((n) => (n.type === "text" ? n.text : ""))).toEqual([
      "Goals for Q4",
      "Risks",
      "From Jarvis",
    ]);
  });

  it("deletes only what the other side left alone, and drops arrows to deleted cards", () => {
    const mine: Canvas = {
      nodes: [card("a", "Goals"), card("c", "New here")],
      edges: [arrow("e1", "a", "c")],
    };
    const theirs: Canvas = { nodes: [card("b", "Risks, edited")], edges: [] };
    const out = mergeCanvas(base, mine, theirs);
    // a: they deleted it, I left it alone → gone. b: I deleted it, they changed it → kept.
    expect(out.nodes.map((n) => n.id)).toEqual(["b", "c"]);
    expect(out.edges).toEqual([]);
  });

  it("prefers this screen's change when both sides changed the same card", () => {
    const mine: Canvas = { ...base, nodes: [card("a", "Mine"), base.nodes[1]!] };
    const theirs: Canvas = { ...base, nodes: [card("a", "Theirs"), base.nodes[1]!] };
    expect(mergeCanvas(base, mine, theirs).nodes[0]).toMatchObject({ text: "Mine" });
  });

  it("reads a card the same whatever order its fields came in", () => {
    const shuffled = { height: 80, width: 200, y: 0, x: 0, text: "Goals", type: "text", id: "a" };
    const mine = { ...base, nodes: [shuffled as Canvas["nodes"][number], base.nodes[1]!] };
    const theirs: Canvas = { ...base, nodes: [card("a", "Theirs"), base.nodes[1]!] };
    expect(mergeCanvas(base, mine, theirs).nodes[0]).toMatchObject({ text: "Theirs" });
  });
});

describe("merging a workbook", () => {
  const sheet = (id: string, name: string, cells: Record<string, string>): Worksheet => ({
    id,
    name,
    cells,
    widths: {},
    formats: {},
    freeze: { rows: 0, cols: 0 },
  });
  const base: Workbook = { sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1200" })] };

  it("merges cell by cell", () => {
    const mine: Workbook = { sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1300" })] };
    const theirs: Workbook = {
      sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1200", A2: "Food", B2: "300" })],
    };
    expect(mergeWorkbook(base, mine, theirs).sheets[0]!.cells).toEqual({
      A1: "Rent",
      B1: "1300",
      A2: "Food",
      B2: "300",
    });
  });

  it("keeps sheets added on both sides, renaming a clash", () => {
    const mine: Workbook = { sheets: [...base.sheets, sheet("m", "Plan", { A1: "1" })] };
    const theirs: Workbook = { sheets: [...base.sheets, sheet("t", "Plan", { A1: "2" })] };
    const out = mergeWorkbook(base, mine, theirs);
    expect(out.sheets.map((s) => s.name)).toEqual(["Costs", "Plan", "Plan (2)"]);
    expect(theirs.sheets[1]!.name).toBe("Plan");
  });

  it("keeps a renamed sheet's new name and the other side's cells", () => {
    const mine: Workbook = { sheets: [sheet("s1", "Spending", base.sheets[0]!.cells)] };
    const theirs: Workbook = { sheets: [sheet("s1", "Costs", { A1: "Rent", B1: "1250" })] };
    const out = mergeWorkbook(base, mine, theirs).sheets[0]!;
    expect([out.name, out.cells.B1]).toEqual(["Spending", "1250"]);
  });

  it("merges formats cell by cell, and the frozen rows like a sheet's name", () => {
    const formatted = (formats: Worksheet["formats"], rows = 0): Workbook => ({
      sheets: [{ ...base.sheets[0]!, formats, freeze: { rows, cols: 0 } }],
    });
    const was = formatted({ A1: { italic: true } });
    // Here: B1 bold, and the top row frozen. Pip, meanwhile: B1 as currency, A1 no longer italic.
    const mine = formatted({ A1: { italic: true }, B1: { bold: true } }, 1);
    const theirs = formatted({ B1: { number: "currency" } });
    const out = mergeWorkbook(was, mine, theirs).sheets[0]!;
    // Both changed B1: this screen's, as with a cell's value.
    expect(out.formats).toEqual({ B1: { bold: true } });
    expect(out.freeze).toEqual({ rows: 1, cols: 0 });
    const other = formatted({ A1: { italic: true }, A2: { fill: "blue" } });
    const both = mergeWorkbook(was, mine, other).sheets[0]!;
    expect(both.formats).toEqual({
      A1: { italic: true },
      B1: { bold: true },
      A2: { fill: "blue" },
    });
    // Unfrozen elsewhere, left alone here: unfrozen.
    expect(mergeWorkbook(mine, mine, formatted(mine.sheets[0]!.formats)).sheets[0]!.freeze).toEqual(
      {
        rows: 0,
        cols: 0,
      },
    );
  });

  it("merges a copy kept on a device before sheets had formats", () => {
    const old = {
      sheets: [{ id: "s1", name: "Costs", cells: { A1: "Rent", B1: "1300" }, widths: {} }],
    } as unknown as Workbook;
    const theirs: Workbook = {
      sheets: [{ ...base.sheets[0]!, formats: { B1: { number: "currency" } } }],
    };
    const out = mergeWorkbook(old, old, theirs).sheets[0]!;
    expect(out).toMatchObject({ cells: { B1: "1200" }, formats: { B1: { number: "currency" } } });
    const typed = mergeWorkbook(base, old, theirs).sheets[0]!;
    expect(typed).toMatchObject({ cells: { B1: "1300" }, formats: { B1: { number: "currency" } } });
  });

  it("clears a cell only the screen cleared", () => {
    expect(mergeRecord({ A1: "x", B1: "y" }, { B1: "y" }, { A1: "x", B1: "z" })).toEqual({
      B1: "z",
    });
    expect(mergeRecord({ A1: "x" }, {}, { A1: "changed" })).toEqual({ A1: "changed" });
  });
});

describe("merging text", () => {
  it("takes whichever side changed, and keeps both sides' new lines when both did", () => {
    expect(mergeText("a", "a b", "a")).toBe("a b");
    expect(mergeText("a", "a", "a c")).toBe("a c");
    expect(mergeText("intro\n", "intro\nmine\n", "intro\ntheirs\n")).toBe("intro\nmine\ntheirs");
    expect(mergeText("x", "y", "y")).toBe("y");
  });
});

// A screen's changes kept before it ever read the saved copy have no base: the saver merges them
// onto an empty one (D59), which must only add to what was saved.
describe("merging onto an empty base", () => {
  it("adds this screen's cards to the board and deletes none", () => {
    const out = mergeCanvas(
      { nodes: [], edges: [] },
      { nodes: [card("n", "Added")], edges: [] },
      { nodes: [card("a", "Original")], edges: [] },
    );
    expect(out.nodes.map((n) => n.id)).toEqual(["a", "n"]);
  });

  it("adds cells typed in a new sheet, keeping the saved sheet's name and cells", () => {
    const mine = emptyWorkbook();
    mine.sheets[0]!.cells.A1 = "typed";
    const theirs: Workbook = {
      sheets: [{ ...emptyWorkbook().sheets[0]!, name: "Budget", cells: { B2: "1250" } }],
    };
    const out = mergeWorkbook(emptyWorkbook(), mine, theirs).sheets;
    expect(out).toEqual([
      {
        id: "s1",
        name: "Budget",
        cells: { B2: "1250", A1: "typed" },
        widths: {},
        formats: {},
        freeze: { rows: 0, cols: 0 },
      },
    ]);
  });

  it("keeps every saved line of notes", () => {
    expect(mergeText("", "agenda\nmine", "agenda\ntheirs")).toBe("agenda\nmine\ntheirs");
  });
});
