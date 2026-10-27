// A spreadsheet (PLAN.md section 8.5's "spreadsheets"): sheets of cells, each cell what you typed
// (a value or a =formula). Results are worked out by IronCalc, in the browser and on the server,
// and never stored as the source.
import { z } from "zod";

export const SHEET_ROWS = 500;
export const SHEET_COLUMNS = 52;
/**
 * How much a workbook holds: what's written is checked against these, and what's read is kept
 * within them.
 */
export const SHEET_LIMITS = {
  sheets: 20,
  name: 31,
  cellText: 2000,
  width: { min: 30, max: 800 },
  frozenRows: 20,
  frozenCols: 10,
} as const;

/**
 * Text that can be kept: cut to `max` (UTF-16 units) but never between an emoji's two halves, and
 * a half on its own (from a clipboard, say) made U+FFFD. The database refuses a lone half, and
 * with it every save of the workbook.
 */
export function keepableText(text: string, max: number = SHEET_LIMITS.cellText): string {
  const whole = text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "�",
  );
  const cut = whole.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** "A1" … "AZ500". */
export const CELL_REF = /^([A-Z]{1,2})([1-9][0-9]{0,3})$/;

export function columnName(col: number): string {
  // 1 → A, 26 → Z, 27 → AA.
  let n = col;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function columnNumber(name: string): number {
  let n = 0;
  for (const c of name) n = n * 26 + (c.charCodeAt(0) - 64);
  return n;
}

/** "B3" → { row: 3, col: 2 }, or null when it isn't a cell on a sheet. */
export function parseCell(ref: string): { row: number; col: number } | null {
  const m = CELL_REF.exec(ref.trim().toUpperCase());
  if (!m) return null;
  const col = columnNumber(m[1]!);
  const row = Number(m[2]);
  if (col > SHEET_COLUMNS || row > SHEET_ROWS) return null;
  return { row, col };
}

export const cellName = (row: number, col: number) => `${columnName(col)}${row}`;

/** A cell as written: its own name, "B3", never "b3" or " B3". */
const cellKey = z
  .string()
  .refine((k) => CELL_REF.test(k) && parseCell(k) !== null, "not a cell like A1");

/** Fills by name: each theme draws its own shade of one, so a fill reads in light and dark alike. */
export const SHEET_FILLS = ["red", "orange", "yellow", "green", "blue", "purple", "gray"] as const;
export type SheetFill = (typeof SHEET_FILLS)[number];

/** Number formats by name, and how IronCalc writes each: a result then reads "$1,200.00". */
export const NUMBER_FORMATS = {
  number: "#,##0.00",
  currency: "$#,##0.00",
  percent: "0%",
  date: "mmm d, yyyy",
} as const;
export type NumberFormat = keyof typeof NUMBER_FORMATS;

// As written: a part that isn't one of these is refused, with what it should be. Reading one back
// (readWorkbook) drops a part that doesn't read on its own instead.
export const CellFormatSchema = z.object({
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  fill: z.enum(SHEET_FILLS).optional(),
  number: z.enum(Object.keys(NUMBER_FORMATS) as [NumberFormat, ...NumberFormat[]]).optional(),
});
export type CellFormat = z.infer<typeof CellFormatSchema>;

/** The format with what it doesn't say (off, unset) left out, or null when that's everything. */
export function tidyFormat(f: CellFormat): CellFormat | null {
  const out = Object.fromEntries(
    Object.entries(f).filter(([, v]) => v !== undefined && v !== false),
  );
  return Object.keys(out).length ? (out as CellFormat) : null;
}

/** Rows at the top and columns at the left that stay put while the rest scrolls. */
export const NO_FREEZE: Readonly<{ rows: number; cols: number }> = Object.freeze({
  rows: 0,
  cols: 0,
});
const freezeSchema = z
  .object({
    rows: z.number().int().min(0).max(SHEET_LIMITS.frozenRows).default(0),
    cols: z.number().int().min(0).max(SHEET_LIMITS.frozenCols).default(0),
  })
  .default(() => ({ ...NO_FREEZE }));

// What's written: Pip's sheet.save and sheet.set, and every save from a screen. Anything that
// doesn't fit is refused with what's wrong. What's kept is read back with readWorkbook, which
// drops or clamps a part that doesn't fit and keeps the rest.
export const WorksheetSchema = z.object({
  id: z.string().min(1).max(40),
  name: z
    .string()
    .trim()
    .min(1)
    .max(SHEET_LIMITS.name)
    // biome-ignore lint/complexity/noUselessEscapeInRegex: the model API's regex engine reads a bare "[" in a class as a nested class and rejects every Jarvis turn.
    .regex(/^[^\[\]:*?/\\']+$/, "sheet names can't use [ ] : * ? / \\ or '"),
  cells: z.record(cellKey, z.string().max(SHEET_LIMITS.cellText)).default({}),
  /** Column widths in pixels, by column letter. */
  widths: z
    .record(
      z.string().regex(/^[A-Z]{1,2}$/),
      z.number().min(SHEET_LIMITS.width.min).max(SHEET_LIMITS.width.max),
    )
    .default({}),
  /** Bold, italic, alignment, fill and number format, by cell; a cell without one has none. */
  formats: z.record(cellKey, CellFormatSchema).default({}),
  freeze: freezeSchema,
});

export const WorkbookSchema = z
  .object({ sheets: z.array(WorksheetSchema).min(1).max(SHEET_LIMITS.sheets) })
  .refine((b) => new Set(b.sheets.map((s) => s.name.toLowerCase())).size === b.sheets.length, {
    message: "two sheets have the same name",
  });

export type Worksheet = z.infer<typeof WorksheetSchema>;
export type Workbook = z.infer<typeof WorkbookSchema>;

/** A new sheet, with nothing in it. */
export const blankSheet = (id: string, name: string): Worksheet => ({
  id,
  name,
  cells: {},
  widths: {},
  formats: {},
  freeze: { ...NO_FREEZE },
});

export const emptyWorkbook = (): Workbook => ({ sheets: [blankSheet("s1", "Sheet1")] });

/** The part of IronCalc's Model that working out a workbook needs. */
export interface CalcModel {
  newSheet(): void;
  renameSheet(sheet: number, name: string): void;
  setUserInput(sheet: number, row: number, column: number, input: string): void;
  updateRangeStyle(
    range: { sheet: number; row: number; column: number; width: number; height: number },
    path: string,
    value: string,
  ): void;
  evaluate(): void;
  getFormattedCellValue(sheet: number, row: number, column: number): string;
  /** 1 a number, 2 text, 4 TRUE or FALSE, 16 an error. */
  getCellType(sheet: number, row: number, column: number): number;
  free(): void;
}

/** Each sheet's results, by cell, for the cells that hold something. */
export type Results = Record<string, string>[];

/** Puts the workbook into an empty model, and works it out. */
function work(book: Workbook, m: CalcModel) {
  book.sheets.forEach((s, i) => {
    if (i > 0) m.newSheet();
    m.renameSheet(i, s.name);
  });
  book.sheets.forEach((s, i) => {
    for (const [ref, input] of Object.entries(s.cells)) {
      const at = parseCell(ref);
      if (at && input !== "") m.setUserInput(i, at.row, at.col, input);
    }
    // After the input, which sets a format of its own when you type "$1,200" or "15%".
    for (const [ref, f] of Object.entries(s.formats ?? {})) {
      const at = parseCell(ref);
      if (at && f.number && s.cells[ref])
        m.updateRangeStyle(
          { sheet: i, row: at.row, column: at.col, width: 1, height: 1 },
          "num_fmt",
          NUMBER_FORMATS[f.number],
        );
    }
  });
  m.evaluate();
}

/** Works out every formula in the workbook. `model` makes an empty IronCalc model. */
export function calculate(book: Workbook, model: () => CalcModel): Results {
  const m = model();
  try {
    work(book, m);
    return book.sheets.map((s, i) => {
      const out: Record<string, string> = {};
      for (const ref of Object.keys(s.cells)) {
        const at = parseCell(ref);
        if (at) out[ref] = m.getFormattedCellValue(i, at.row, at.col);
      }
      return out;
    });
  } finally {
    m.free();
  }
}

/** Typed first, it makes the rest text, whatever it looks like: '=x is the text "=x". */
export const AS_TEXT = "'";

/**
 * Each formula's value among `refs` on one sheet, as what to type for that value alone (Paste
 * values only): a number unformatted, to the 15 digits a spreadsheet keeps ("5%" is 0.0525 and
 * "$33.33" 33.3333333333333); text as itself, after AS_TEXT when typing it would make something
 * else (a formula, a number, TRUE); TRUE, FALSE and errors as they read.
 */
export function formulaValues(
  book: Workbook,
  sheet: number,
  refs: string[],
  model: () => CalcModel,
): Record<string, string> {
  const s = book.sheets[sheet];
  const formulas = refs.flatMap((ref) => {
    const at = s?.cells[ref]?.startsWith("=") ? parseCell(ref) : null;
    return at ? [{ ref, ...at }] : [];
  });
  if (!formulas.length) return {};
  const m = model();
  try {
    work(book, m);
    const out: Record<string, string> = {};
    const texts: typeof formulas = [];
    for (const f of formulas) {
      const type = m.getCellType(sheet, f.row, f.col);
      out[f.ref] = m.getFormattedCellValue(sheet, f.row, f.col);
      if (type === 2) texts.push(f);
      if (type !== 1) continue;
      // Every digit IronCalc keeps, then written as short as it reads: 3.33333333333333E+01 is
      // 33.3333333333333.
      const at = { sheet, row: f.row, column: f.col, width: 1, height: 1 };
      m.updateRangeStyle(at, "num_fmt", "0.##############E+00");
      const n = Number(m.getFormattedCellValue(sheet, f.row, f.col));
      if (Number.isFinite(n)) out[f.ref] = String(n).toUpperCase();
    }
    // Once every value is read, each text is typed back into its own cell: does it stay that text?
    for (const f of texts) {
      const text = out[f.ref]!;
      if (!text.startsWith("=") && !text.startsWith(AS_TEXT)) {
        m.setUserInput(sheet, f.row, f.col, text);
        const still = m.getCellType(sheet, f.row, f.col) === 2;
        if (still && m.getFormattedCellValue(sheet, f.row, f.col) === text) continue;
      }
      out[f.ref] = `${AS_TEXT}${text}`;
    }
    return out;
  } finally {
    m.free();
  }
}

/** A sheet's name as a formula writes it: bare when it can be, otherwise in single quotes. */
export function sheetRef(name: string): string {
  const bare = /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name);
  return bare ? name : `'${name}'`;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Renames a sheet, and every reference to it in every formula (=Costs!B3 becomes
 * ='Monthly costs'!B3), leaving text in "quotes" alone. Returns a new workbook.
 */
export function renameSheetRefs(book: Workbook, sheet: number, name: string): Workbook {
  const old = book.sheets[sheet]?.name;
  if (old === undefined || old === name) return book;
  const quoted = new RegExp(`'${escapeRe(old)}'!`, "gi");
  const bare = new RegExp(`(?<![A-Za-z0-9_.'])${escapeRe(old)}!`, "gi");
  const to = `${sheetRef(name)}!`;
  // Outside "strings" only: the even pieces of a split on string literals.
  const rewrite = (formula: string) =>
    formula
      .split(/("(?:[^"]|"")*")/)
      .map((part, i) => (i % 2 ? part : part.replace(quoted, to).replace(bare, to)))
      .join("");
  return {
    sheets: book.sheets.map((s, i) => ({
      ...s,
      name: i === sheet ? name : s.name,
      cells: Object.fromEntries(
        Object.entries(s.cells).map(([ref, v]) => [ref, v.startsWith("=") ? rewrite(v) : v]),
      ),
    })),
  };
}

/** The workbook as markdown tables of results, for search, backlinks and Jarvis. */
export function workbookMarkdown(book: Workbook, results: Results, maxRows = 60, maxCols = 15) {
  const parts: string[] = [];
  book.sheets.forEach((s, i) => {
    const refs = Object.keys(s.cells)
      .map(parseCell)
      .filter((x): x is { row: number; col: number } => x !== null);
    if (!refs.length) return;
    const rows = Math.min(maxRows, Math.max(...refs.map((r) => r.row)));
    const cols = Math.min(maxCols, Math.max(...refs.map((r) => r.col)));
    const cell = (v = "") =>
      v
        .replace(/<(\/?m-ref)/gi, "‹$1")
        .replace(/\|/g, "\\|")
        .replace(/\s*\n\s*/g, " ");
    const lines = [
      `## ${s.name}`,
      "",
      `| | ${Array.from({ length: cols }, (_, c) => columnName(c + 1)).join(" | ")} |`,
      `|---|${Array.from({ length: cols }, () => "---").join("|")}|`,
    ];
    for (let r = 1; r <= rows; r++) {
      const row = Array.from({ length: cols }, (_, c) => cell(results[i]?.[cellName(r, c + 1)]));
      if (row.some(Boolean)) lines.push(`| ${r} | ${row.join(" | ")} |`);
    }
    parts.push(lines.join("\n"));
  });
  return parts.join("\n\n");
}
