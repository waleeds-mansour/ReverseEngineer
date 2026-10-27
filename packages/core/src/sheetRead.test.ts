import { describe, expect, it } from "vitest";
import { type Workbook, WorkbookSchema } from "./sheet.ts";
import { filledWorkbook, readFormat, readWorkbook } from "./sheetRead.ts";

const none = { rows: 0, cols: 0 };
const one = (sheet: object) => ({
  sheets: [{ id: "s1", name: "Budget", cells: { A1: "1200", B1: "=A1*2" }, ...sheet }],
});

describe("reading a kept workbook", () => {
  it("keeps the rest of a workbook with a bad width, cell or sheet name", () => {
    const cases = [
      { widths: { A: 5000, B: "wide", "1": 90, c: 120 } },
      { cells: { A1: "1200", B1: "=A1*2", ZZ9: "off", A501: "off", b2: "lower", C1: 7, D1: {} } },
      { name: "Plan: Q4?" },
      { name: "" },
      { id: 42 },
    ];
    for (const sheet of cases) {
      // Each of these failed the whole workbook: it loaded empty.
      expect(WorkbookSchema.safeParse(one(sheet)).success).toBe(false);
      const book = readWorkbook(one(sheet));
      expect(book?.sheets[0]?.cells).toMatchObject({ A1: "1200", B1: "=A1*2" });
      expect(WorkbookSchema.safeParse(book).success).toBe(true);
    }
    const [widths, cells, named, blank, id] = cases.map((c) => readWorkbook(one(c))!.sheets[0]!);
    // A width past the limit is clamped, one that isn't a number or a column is dropped.
    expect(widths!.widths).toEqual({ A: 800, C: 120 });
    // A cell off the sheet goes; "b2" is B2; a number kept bare is its text.
    expect(cells!.cells).toEqual({ A1: "1200", B1: "=A1*2", B2: "lower", C1: "7" });
    expect([named!.name, blank!.name, id!.id]).toEqual(["Plan Q4", "Sheet1", "s1"]);
  });

  it("drops a format that doesn't read, never the workbook", () => {
    const book = readWorkbook({
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
    const [budget, plan] = book!.sheets;
    expect(budget!.cells).toEqual({ A1: "1200", A2: "300" });
    expect(budget!.formats).toEqual({ A1: { italic: true }, A2: { number: "currency" } });
    expect(budget!.freeze).toEqual({ rows: 0, cols: 2 });
    expect(plan).toMatchObject({ cells: { B1: "x" }, formats: {}, freeze: none });
    expect(readFormat({ bold: true, fill: "teal" })).toEqual({ bold: true });
    expect([readFormat({ bold: false }), readFormat("bold"), readFormat(null)]).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("clamps what's too much, and tells apart sheets with one id or name", () => {
    const long = "x".repeat(3000);
    const sheets = Array.from({ length: 25 }, (_, i) => ({
      id: i < 2 ? "same" : `s${i}`,
      name: i < 12 ? "Plan" : `Sheet ${i}`,
      cells: { A1: long },
      freeze: { rows: 50.7, cols: 3.2 },
    }));
    const book = readWorkbook({ sheets: [null, "sheet", ...sheets] })!;
    expect(book.sheets).toHaveLength(20);
    expect(book.sheets.map((s) => s.id).slice(0, 3)).toEqual(["same", "same-2", "s2"]);
    expect(book.sheets.map((s) => s.name).slice(0, 3)).toEqual(["Plan", "Plan (2)", "Plan (3)"]);
    expect(book.sheets[0]!.cells.A1).toHaveLength(2000);
    expect(book.sheets[0]!.freeze).toEqual({ rows: 20, cols: 3 });
    // "A1" written as itself wins over an "a1" beside it.
    const twice = readWorkbook({ sheets: [{ id: "a", name: "A", cells: { a1: "x", A1: "y" } }] });
    expect(twice!.sheets[0]!.cells).toEqual({ A1: "y" });
    const long31 = readWorkbook({ sheets: Array(12).fill({ id: "a", name: "y".repeat(31) }) })!;
    expect(long31.sheets[11]!.name).toBe(`${"y".repeat(26)} (12)`);
    expect(WorkbookSchema.safeParse(book).success).toBe(true);
    expect(WorkbookSchema.safeParse(long31).success).toBe(true);
    // A name cut at the limit keeps an emoji whole or leaves it out, never half of it.
    const emoji = readWorkbook({ sheets: [{ id: "a", name: `${"y".repeat(30)}\u{1F600}` }] });
    expect(emoji!.sheets[0]!.name).toBe("y".repeat(30));
    expect(
      readWorkbook({ sheets: [{ id: "a", cells: { A1: `${"x".repeat(1999)}\u{1F600}` } }] })!
        .sheets[0]!.cells.A1,
    ).toBe("x".repeat(1999));
  });

  it("keeps every sheet on a screen, so too many after a merge is refused when saved, not cut", () => {
    const sheets = Array.from({ length: 21 }, (_, i) => ({
      id: `s${i}`,
      name: `S${i}`,
      cells: {},
    }));
    expect(readWorkbook({ sheets })!.sheets).toHaveLength(20);
    const shown = filledWorkbook({ sheets });
    expect(shown.sheets).toHaveLength(21);
    expect(WorkbookSchema.safeParse(shown).success).toBe(false);
  });

  it("reads nothing from what holds no sheet, and fills one kept before formats", () => {
    for (const raw of [null, "book", {}, { sheets: {} }, { sheets: [] }, { sheets: [1, null] }])
      expect(readWorkbook(raw)).toBeNull();
    expect(filledWorkbook(null).sheets.map((s) => s.name)).toEqual(["Sheet1"]);
    const saved = { sheets: [{ id: "s1", name: "Budget", cells: { A1: "1200" }, widths: {} }] };
    expect(filledWorkbook(saved as unknown as Workbook).sheets[0]).toEqual({
      ...saved.sheets[0],
      formats: {},
      freeze: none,
    });
  });
});
