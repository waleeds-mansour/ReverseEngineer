import { describe, expect, it } from "vitest";
import { applyFormat, cellStyle, numberLabel, sameFormat, turnsOn } from "./format.ts";

describe("formatting cells", () => {
  it("puts a format on each cell of a range, and takes a part off with null", () => {
    const before = { A1: { italic: true }, B1: { bold: true, fill: "blue" as const } };
    const bold = applyFormat(before, ["A1", "A2"], { bold: true, number: "currency" });
    expect(bold).toEqual({
      A1: { italic: true, bold: true, number: "currency" },
      A2: { bold: true, number: "currency" },
      B1: { bold: true, fill: "blue" },
    });
    // A cell with nothing left has no entry at all.
    expect(applyFormat(bold, ["A2", "B1"], { bold: null, number: null, fill: null })).toEqual({
      A1: { italic: true, bold: true, number: "currency" },
    });
    expect(before).toEqual({ A1: { italic: true }, B1: { bold: true, fill: "blue" } });
  });

  it("tells formats apart by what they say, not how they're written", () => {
    expect(sameFormat({ bold: true, number: "currency" }, { number: "currency", bold: true })).toBe(
      true,
    );
    expect(sameFormat(undefined, null)).toBe(true);
    expect(sameFormat({ bold: false }, null)).toBe(true);
    expect(sameFormat({ bold: true }, { bold: true, italic: true })).toBe(false);
    expect(sameFormat({ fill: "red" }, { fill: "blue" })).toBe(false);
  });

  it("turns bold on across a mixed range, and off only when it's all bold", () => {
    const formats = { A1: { bold: true }, A2: { italic: true } };
    expect(turnsOn(formats, ["A1", "A2"], "bold")).toBe(true);
    expect(turnsOn(formats, ["A1"], "bold")).toBe(false);
    expect(turnsOn(formats, ["A3"], "italic")).toBe(true);
  });

  it("draws a cell as its format says, with numbers and dates on the right", () => {
    expect(cellStyle({ bold: true, italic: true }, "Rent")).toMatchObject({
      "font-weight": "600",
      "font-style": "italic",
      "text-align": undefined,
      background: undefined,
    });
    expect(cellStyle(undefined, "$1,500.00")["text-align"]).toBe("right");
    expect(cellStyle({ number: "date" }, "Oct 27, 2026")["text-align"]).toBe("right");
    expect(cellStyle({ align: "center" }, "42")["text-align"]).toBe("center");
    // A fill in the theme's own colour, the selection over it, the panel under a frozen cell.
    const look = cellStyle({ fill: "green" }, "", { selected: true, frozen: true });
    expect(look.background).toBe(
      "linear-gradient(color-mix(in oklab, var(--color-jarvis) 10%, transparent), color-mix(in oklab, var(--color-jarvis) 10%, transparent)), " +
        "linear-gradient(color-mix(in oklab, var(--color-chart-3) 24%, transparent), color-mix(in oklab, var(--color-chart-3) 24%, transparent)), " +
        "var(--color-panel)",
    );
    expect([numberLabel(), numberLabel("currency")]).toEqual(["Automatic", "Currency"]);
  });
});
