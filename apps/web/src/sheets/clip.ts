// Copying and pasting cells. A copy goes on the clipboard as tab-separated text, which Excel,
// Google Sheets and any text box take, and beside it as the cells with their formats, under a type
// of Nook's own, so a paste into a Nook sheet puts both down. Text from anywhere else pastes as
// it always has, without formats. Ctrl+Shift+V pastes values only, as in Google Sheets: each
// formula's value in its place (a number unformatted, text as text: formulaValues in
// @hearth/core) and no formats. Until the formula engine has loaded, in the first moment a sheet
// is open, a formula's value is its result as shown. A browser that keeps no type of its own on
// the clipboard still has the last copy made here, while the text on the clipboard is that copy's.
import {
  AS_TEXT,
  type CellFormat,
  cellName,
  keepableText,
  readFormat,
  SHEET_COLUMNS,
  SHEET_ROWS,
} from "@hearth/core";
import { fromTsv, type Pos, type Range, toTsv } from "./grid.ts";

/** The clipboard type a Nook copy's cells and formats go under, beside its text. */
export const CELLS_TYPE = "application/x-nook-cells";

/** A cell as copied: what was typed, what to type for a formula's value alone, its format. */
export type CopiedCell = { value: string; result?: string; format?: CellFormat };
export type Copied = { text: string; rows: CopiedCell[][] };
/** What a paste puts down: inputs by cell ("" clears), and formats by cell (null clears). */
export type Pasted = { cells: Record<string, string>; formats: Record<string, CellFormat | null> };

let last: Copied | null = null;

// The clipboard may hand text back with Windows line ends, or with a line end added.
const plain = (text: string) => text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
const cut = (v: string) => keepableText(v);

/** A result as shown, to type back as itself: text, when it starts with = or '. */
export const asTyped = (shown: string) =>
  shown.startsWith("=") || shown.startsWith(AS_TEXT) ? `${AS_TEXT}${shown}` : shown;

/** A range's inputs and formats, with what to type for each formula's value alone (`value`). */
export function copyRange(
  r: Range,
  input: (ref: string) => string,
  value: (ref: string) => string,
  formats: Record<string, CellFormat>,
): Copied {
  const rows: CopiedCell[][] = [];
  for (let row = r.top; row <= r.bottom; row++) {
    const cells: CopiedCell[] = [];
    for (let col = r.left; col <= r.right; col++) {
      const ref = cellName(row, col);
      const cell: CopiedCell = { value: input(ref) };
      if (cell.value.startsWith("=")) cell.result = value(ref);
      if (formats[ref]) cell.format = { ...formats[ref] };
      cells.push(cell);
    }
    rows.push(cells);
  }
  return { text: toTsv(r, input), rows };
}

/** Cells as a Nook copy wrote them, or null. Anything can be on a clipboard: each part is read. */
export function readCells(json: string): CopiedCell[][] | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  const rows = (data as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows)) return null;
  return rows.slice(0, SHEET_ROWS).map((row) =>
    (Array.isArray(row) ? row.slice(0, SHEET_COLUMNS) : []).map((c): CopiedCell => {
      const got = (c ?? {}) as Record<string, unknown>;
      const cell: CopiedCell = { value: typeof got.value === "string" ? cut(got.value) : "" };
      if (typeof got.result === "string") cell.result = cut(got.result);
      const format = readFormat(got.format);
      if (format) cell.format = format;
      return cell;
    }),
  );
}

/**
 * Copied cells put down from `at`, none past the sheet's edge: each with its input and format, or
 * for `valuesOnly` a formula's value in its place, and the formats there left as they are.
 */
export function placeCells(rows: CopiedCell[][], at: Pos, valuesOnly = false): Pasted {
  const out: Pasted = { cells: {}, formats: {} };
  rows.forEach((cells, i) => {
    cells.forEach((c, j) => {
      const row = at.row + i;
      const col = at.col + j;
      if (row > SHEET_ROWS || col > SHEET_COLUMNS) return;
      const ref = cellName(row, col);
      out.cells[ref] = valuesOnly ? (c.result ?? c.value) : c.value;
      if (!valuesOnly) out.formats[ref] = c.format ?? null;
    });
  });
  return out;
}

/** Puts a copy on the clipboard, and keeps it for a paste here. */
export function copyTo(data: DataTransfer | null, copied: Copied) {
  last = copied;
  data?.setData("text/plain", copied.text);
  data?.setData(CELLS_TYPE, JSON.stringify({ rows: copied.rows }));
}

/** What a paste puts down from `at`: a Nook copy as it was copied, anything else as its text. */
export function pasteFrom(data: DataTransfer | null, at: Pos, valuesOnly = false): Pasted | null {
  const text = data?.getData("text/plain") ?? "";
  const ours = data?.getData(CELLS_TYPE);
  const kept = last && text && plain(text) === plain(last.text) ? last.rows : null;
  const rows = ours ? readCells(ours) : kept;
  if (rows?.length) return placeCells(rows, at, valuesOnly);
  if (!text) return null;
  const cells = Object.entries(fromTsv(text, at)).map(([ref, v]) => [ref, cut(v)]);
  return { cells: Object.fromEntries(cells), formats: {} };
}
