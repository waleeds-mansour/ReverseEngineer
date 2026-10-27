// A workbook read back from where it was kept (Nook's database, a copy kept on a device), made of
// whatever in it this version can read. Each part stands alone: a cell, width, format or sheet
// that doesn't read is dropped, a number past a limit is brought within it, and a sheet name that
// can't be one is made into one. None of that fails the workbook: one that failed would load as an
// empty one, and the next save would write that over the real one. Writes stay strict
// (WorkbookSchema refuses what doesn't fit), and what this returns always passes it.
import {
  type CellFormat,
  CellFormatSchema,
  cellName,
  emptyWorkbook,
  keepableText,
  parseCell,
  SHEET_LIMITS,
  tidyFormat,
  type Workbook,
  type Worksheet,
} from "./sheet.ts";

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** A cell's format, with each part that reads; null when none does, or none says anything. */
export function readFormat(raw: unknown): CellFormat | null {
  if (!isRecord(raw)) return null;
  const out: Raw = {};
  for (const [k, part] of Object.entries(CellFormatSchema.shape)) {
    const read = part.safeParse(raw[k]);
    if (read.success) out[k] = read.data;
  }
  return tidyFormat(out as CellFormat);
}

/**
 * Entries under the name each key goes by (`name` is null for a key that can't be one), with what
 * `read` makes of each value (null drops it). When two keys go by one name ("a1" and "A1"), the
 * one written that way wins.
 */
function byName<T>(
  raw: unknown,
  name: (key: string) => string | null,
  read: (value: unknown) => T | null,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!isRecord(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const key = name(k);
    const value = key === null ? null : read(v);
    if (key !== null && value !== null && (!Object.hasOwn(out, key) || k === key)) out[key] = value;
  }
  return out;
}

const cellRef = (k: string) => {
  const at = parseCell(k);
  return at && cellName(at.row, at.col);
};
const column = (k: string) => {
  const c = k.trim().toUpperCase();
  return /^[A-Z]{1,2}$/.test(c) ? c : null;
};
/** What's in a cell: text past the limit is cut there, and a number kept bare is its text. */
const cellText = (v: unknown) =>
  typeof v === "string" ? keepableText(v) : finite(v) ? String(v) : null;
const width = (v: unknown) =>
  finite(v) ? clamp(v, SHEET_LIMITS.width.min, SHEET_LIMITS.width.max) : null;
const count = (v: unknown, max: number) => (finite(v) ? clamp(Math.floor(v), 0, max) : 0);

/** A name a sheet can have: without what names can't use, cut to the limit, or else SheetN. */
function sheetName(v: unknown, i: number) {
  const clean = typeof v === "string" ? v.replace(/[[\]:*?/\\']/g, "").trim() : "";
  return keepableText(clean, SHEET_LIMITS.name).trimEnd() || `Sheet${i + 1}`;
}

/** `base`, or base with a number when it's taken: "Plan (2)", cut so it stays within `max`. */
function unique(base: string, taken: Set<string>, max: number, numbered: (n: number) => string) {
  let out = base;
  for (let n = 2; taken.has(out.toLowerCase()); n++) {
    const end = numbered(n);
    out = `${keepableText(base, max - end.length).trimEnd()}${end}`;
  }
  taken.add(out.toLowerCase());
  return out;
}

/**
 * The workbook in `raw`, or null when it holds no sheet to read. Sheets past `maxSheets` are left
 * out; of two with one id, or one name in any case, the later one gets a number.
 */
export function readWorkbook(
  raw: unknown,
  maxSheets: number = SHEET_LIMITS.sheets,
): Workbook | null {
  if (!isRecord(raw) || !Array.isArray(raw.sheets)) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  const sheets: Worksheet[] = [];
  for (const s of raw.sheets) {
    if (sheets.length >= maxSheets) break;
    if (!isRecord(s)) continue;
    const i = sheets.length;
    const id = typeof s.id === "string" && s.id.length && s.id.length <= 40 ? s.id : `s${i + 1}`;
    const freeze = isRecord(s.freeze) ? s.freeze : {};
    sheets.push({
      id: unique(id, ids, 40, (n) => `-${n}`),
      name: unique(sheetName(s.name, i), names, SHEET_LIMITS.name, (n) => ` (${n})`),
      cells: byName(s.cells, cellRef, cellText),
      widths: byName(s.widths, column, width),
      formats: byName(s.formats, cellRef, readFormat),
      freeze: {
        rows: count(freeze.rows, SHEET_LIMITS.frozenRows),
        cols: count(freeze.cols, SHEET_LIMITS.frozenCols),
      },
    });
  }
  return sheets.length ? { sheets } : null;
}

/**
 * A workbook as a screen shows it, from wherever it was kept: one saved before sheets had formats
 * has none, and one with no sheet to read is a blank one. It keeps every sheet, past the limit
 * too: two screens' sheets merged can be too many, and then the save is refused where it shows,
 * rather than a sheet and what's on it dropped without a word.
 */
export const filledWorkbook = (raw: unknown): Workbook =>
  readWorkbook(raw, Number.POSITIVE_INFINITY) ?? emptyWorkbook();
