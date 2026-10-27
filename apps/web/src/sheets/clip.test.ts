import { describe, expect, it } from "vitest";
import {
  asTyped,
  CELLS_TYPE,
  copyRange,
  copyTo,
  pasteFrom,
  placeCells,
  readCells,
} from "./clip.ts";
import { rangeOf } from "./grid.ts";

/** A clipboard; `only` keeps just those types, as a browser that drops a type of Nook's own. */
const clipboard = (only?: string[]) => {
  const kept = new Map<string, string>();
  return {
    setData(type: string, value: string) {
      if (!only || only.includes(type)) kept.set(type, value);
    },
    getData: (type: string) => kept.get(type) ?? "",
    kept,
  } as unknown as DataTransfer & { kept: Map<string, string> };
};

const inputs: Record<string, string> = { A1: "Rent", B1: "1200", A2: "Total", B2: "=B1*2" };
/** What the engine says to type for each formula's value alone: 2400, not "$2,400.00". */
const values: Record<string, string> = { B2: "2400" };
const formats = { A1: { bold: true }, B1: { number: "currency" as const, fill: "green" as const } };
const copied = () =>
  copyRange(
    rangeOf({ row: 1, col: 1 }, { row: 2, col: 2 }),
    (ref) => inputs[ref] ?? "",
    (ref) => values[ref] ?? "",
    formats,
  );

describe("copying and pasting cells", () => {
  it("pastes a Nook copy with its formats, and clears the format of a cell copied without one", () => {
    const data = clipboard();
    copyTo(data, copied());
    expect(data.getData("text/plain")).toBe("Rent\t1200\nTotal\t=B1*2");
    expect(pasteFrom(data, { row: 5, col: 3 })).toEqual({
      cells: { C5: "Rent", D5: "1200", C6: "Total", D6: "=B1*2" },
      formats: {
        C5: { bold: true },
        D5: { number: "currency", fill: "green" },
        C6: null,
        D6: null,
      },
    });
  });

  it("pastes values only with Ctrl+Shift+V: a formula's value, and the formats there stay", () => {
    const data = clipboard();
    copyTo(data, copied());
    expect(pasteFrom(data, { row: 1, col: 4 }, true)).toEqual({
      cells: { D1: "Rent", E1: "1200", D2: "Total", E2: "2400" },
      formats: {},
    });
    // Before the engine has loaded, a result as shown: text that types as a formula stays text.
    expect([asTyped("=x"), asTyped("'q"), asTyped("$2,400.00")]).toEqual([
      "'=x",
      "''q",
      "$2,400.00",
    ]);
  });

  it("pastes text from anywhere else as it always has, without formats", () => {
    const data = clipboard();
    data.setData("text/plain", "a\tb\r\nc\td\r\n");
    expect(pasteFrom(data, { row: 1, col: 1 })).toEqual({
      cells: { A1: "a", B1: "b", A2: "c", B2: "d" },
      formats: {},
    });
    expect(pasteFrom(clipboard(), { row: 1, col: 1 })).toBeNull();
  });

  it("keeps the last copy for a browser that drops Nook's own type, while the text is its", () => {
    const data = clipboard(["text/plain"]);
    copyTo(data, copied());
    expect(data.kept.has(CELLS_TYPE)).toBe(false);
    // Windows hands the text back with its own line ends.
    const back = clipboard();
    back.setData("text/plain", "Rent\t1200\r\nTotal\t=B1*2\r\n");
    expect(pasteFrom(back, { row: 1, col: 1 })?.formats.A1).toEqual({ bold: true });
    // Something else copied since: its text, no formats.
    const other = clipboard();
    other.setData("text/plain", "Rent\t1300");
    expect(pasteFrom(other, { row: 1, col: 1 })).toEqual({
      cells: { A1: "Rent", B1: "1300" },
      formats: {},
    });
  });

  it("reads a copy from the clipboard part by part, and puts nothing past the sheet's edge", () => {
    expect(readCells("not json")).toBeNull();
    expect(readCells('{"rows": 3}')).toBeNull();
    expect(
      readCells(
        JSON.stringify({
          rows: [
            [
              { value: "x".repeat(2500), format: { bold: true, fill: "teal" } },
              { value: 7, result: "7", format: "bold" },
              null,
            ],
            "row",
          ],
        }),
      ),
    ).toEqual([
      [
        { value: "x".repeat(2000), format: { bold: true } },
        { value: "", result: "7" },
        { value: "" },
      ],
      [],
    ]);
    // Cut at the limit without splitting an emoji, and a lone half made keepable.
    const emoji = { value: `${"x".repeat(1999)}\u{1F600}` };
    expect(readCells(JSON.stringify({ rows: [[emoji]] }))).toEqual([[{ value: "x".repeat(1999) }]]);
    expect(readCells('{"rows":[[{"value":"a\\ud83d"}]]}')).toEqual([[{ value: "a�" }]]);
    const at = placeCells(
      [
        [{ value: "a" }, { value: "b" }],
        [{ value: "c" }, { value: "d" }],
      ],
      { row: 500, col: 52 },
    );
    expect(at).toEqual({ cells: { AZ500: "a" }, formats: { AZ500: null } });
  });
});
