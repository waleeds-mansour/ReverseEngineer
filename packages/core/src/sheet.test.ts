import { describe, expect, it } from "vitest";
import {
  type CalcModel,
  calculate,
  cellName,
  columnName,
  columnNumber,
  keepableText,
  parseCell,
  renameSheetRefs,
  sheetRef,
  type Workbook,
  WorkbookSchema,
} from "./sheet.ts";

describe("spreadsheet cells", () => {
  it("names columns like a spreadsheet", () => {
    expect([1, 26, 27, 52].map(columnName)).toEqual(["A", "Z", "AA", "AZ"]);
    expect(columnNumber("AZ")).toBe(52);
    expect(parseCell("b3")).toEqual({ row: 3, col: 2 });
    expect(parseCell("BA1")).toBeNull();
    expect(parseCell("A501")).toBeNull();
    expect(cellName(10, 27)).toBe("AA10");
  });

  it("cuts text to fit without splitting an emoji, which the database couldn't keep", () => {
    const smile = "\u{1F600}"; // two UTF-16 halves
    expect(keepableText(`a${smile}`, 2)).toBe("a");
    expect(keepableText(`a${smile}`, 3)).toBe(`a${smile}`);
    expect(keepableText("x".repeat(2500))).toHaveLength(2000);
    // A half on its own, as a clipboard can hold, can't be kept either.
    expect(keepableText("a\uD83Db\uDE00")).toBe("a�b�");
    expect(JSON.stringify(keepableText(`${"x".repeat(1999)}${smile}`))).not.toMatch(/\\ud/i);
  });

  it("refuses cells off the sheet and sheets with the same name", () => {
    const sheet = (name: string, cells = {}) => ({ id: name, name, cells });
    expect(WorkbookSchema.safeParse({ sheets: [sheet("A", { ZZ9: "1" })] }).success).toBe(false);
    expect(WorkbookSchema.safeParse({ sheets: [sheet("A"), sheet("a")] }).success).toBe(false);
    expect(WorkbookSchema.safeParse({ sheets: [sheet("Budget", { A1: "=1+1" })] }).success).toBe(
      true,
    );
  });
});

const none = { rows: 0, cols: 0 };

describe("renaming a sheet", () => {
  const book: Workbook = {
    sheets: [
      { id: "a", name: "Costs", cells: { B3: "1500" }, widths: {}, formats: {}, freeze: none },
      {
        id: "b",
        name: "Plan",
        cells: {
          A1: "=Costs!B3*12",
          A2: "=SUM('Costs'!B1:B3) + costs!B3",
          A3: '="Costs!B3 is the total"',
          A4: "=MyCosts!B3",
          A5: "Costs!B3",
        },
        widths: {},
        formats: { A1: { bold: true } },
        freeze: { rows: 1, cols: 0 },
      },
    ],
  };

  it("rewrites every formula that points at it, and nothing else", () => {
    const out = renameSheetRefs(book, 0, "Monthly costs");
    expect(out.sheets[0]!.name).toBe("Monthly costs");
    expect(out.sheets[1]!.cells).toEqual({
      A1: "='Monthly costs'!B3*12",
      A2: "=SUM('Monthly costs'!B1:B3) + 'Monthly costs'!B3",
      A3: '="Costs!B3 is the total"',
      A4: "=MyCosts!B3",
      A5: "Costs!B3",
    });
    expect(renameSheetRefs(book, 0, "Spend").sheets[1]!.cells.A1).toBe("=Spend!B3*12");
    expect(book.sheets[0]!.name).toBe("Costs");
    expect(out.sheets[1]).toMatchObject({ formats: { A1: { bold: true } }, freeze: { rows: 1 } });
  });

  it("quotes a name that couldn't stand bare", () => {
    expect([sheetRef("Q4"), sheetRef("AB12"), sheetRef("Q4 plan"), sheetRef("Budget_2")]).toEqual([
      "'Q4'",
      "'AB12'",
      "'Q4 plan'",
      "Budget_2",
    ]);
  });
});

describe("formatting cells", () => {
  it("reads a workbook saved before formatting with none", () => {
    const saved = { sheets: [{ id: "s1", name: "Budget", cells: { A1: "1200" }, widths: {} }] };
    const book = WorkbookSchema.parse(saved);
    expect(book.sheets[0]).toMatchObject({ cells: { A1: "1200" }, formats: {}, freeze: none });
  });

  it("refuses a write with a format, freeze or cell that doesn't fit, saying what's wrong", () => {
    const sheet = (more: object) => ({ sheets: [{ id: "s1", name: "Budget", ...more }] });
    for (const bad of [
      { formats: { A1: { number: "money" } } },
      { formats: { A1: { bold: "very" } } },
      { formats: { ZZ9: { bold: true } } },
      { freeze: { rows: -1, cols: 0 } },
      { freeze: { rows: 1, cols: 11 } },
      { cells: { a1: "lower case" } },
      { widths: { A: 5000 } },
    ])
      expect(WorkbookSchema.safeParse(sheet(bad)).success).toBe(false);
    const money = WorkbookSchema.safeParse(sheet({ formats: { A1: { number: "money" } } }));
    expect(money.error?.issues[0]?.message).toContain('"currency"');
    const ok = WorkbookSchema.parse(
      sheet({ formats: { A1: { bold: true, number: "currency" } }, freeze: { rows: 1 } }),
    );
    expect(ok.sheets[0]).toMatchObject({
      formats: { A1: { bold: true, number: "currency" } },
      freeze: { rows: 1, cols: 0 },
    });
  });

  it("gives IronCalc each number format after what was typed, and only for cells with something in", () => {
    const calls: string[] = [];
    const model = (): CalcModel => ({
      newSheet() {},
      renameSheet() {},
      setUserInput: (_s, row, col, input) => void calls.push(`${cellName(row, col)}=${input}`),
      updateRangeStyle: (a, path, value) =>
        void calls.push(`${cellName(a.row, a.column)} ${path} ${value}`),
      evaluate: () => void calls.push("evaluate"),
      getFormattedCellValue: () => "",
      getCellType: () => 1,
      free() {},
    });
    const book = WorkbookSchema.parse({
      sheets: [
        {
          id: "s1",
          name: "S",
          cells: { A1: "$1,200", A2: "0.25" },
          formats: {
            A1: { number: "currency" },
            A2: { number: "percent", bold: true },
            A3: { number: "date" },
          },
        },
      ],
    });
    calculate(book, model);
    expect(calls).toEqual([
      "A1=$1,200",
      "A2=0.25",
      "A1 num_fmt $#,##0.00",
      "A2 num_fmt 0%",
      "evaluate",
    ]);
  });
});
