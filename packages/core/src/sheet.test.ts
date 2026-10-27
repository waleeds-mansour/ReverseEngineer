import { describe, expect, it } from "vitest";
import {
  type CalcModel,
  calculate,
  cellName,
  columnName,
  columnNumber,
  filledWorkbook,
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
    // A copy kept on a device back then, read without the schema, gets the same.
    expect(filledWorkbook(saved as unknown as Workbook).sheets[0]).toMatchObject({
      formats: {},
      freeze: none,
    });
  });

  it("drops a format that doesn't read, never the workbook", () => {
    const parsed = WorkbookSchema.safeParse({
      sheets: [
        {
          id: "s1",
          name: "Budget",
          cells: { A1: "1200", A2: "300" },
          formats: {
            A1: { bold: "very", italic: true, number: "money", fill: "#ff0000" },
            a2: { number: "currency", align: "justify" },
            ZZ9: { bold: true },
            A3: "bold",
            A4: { bold: false },
          },
          freeze: { rows: -1, cols: 2 },
        },
        { id: "s2", name: "Plan", cells: { B1: "x" }, formats: [1, 2], freeze: "top row" },
      ],
    });
    expect(parsed.success).toBe(true);
    const [budget, plan] = parsed.data!.sheets;
    expect(budget!.cells).toEqual({ A1: "1200", A2: "300" });
    expect(budget!.formats).toEqual({ A1: { italic: true }, A2: { number: "currency" } });
    expect(budget!.freeze).toEqual({ rows: 0, cols: 2 });
    expect(plan).toMatchObject({ cells: { B1: "x" }, formats: {}, freeze: none });
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
