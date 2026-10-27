// How a cell looks: its formats (bold, italic, which side, fill), and changing them across a range
// the way any spreadsheet does. A fill is kept by name and drawn in the theme's own shade of it, so
// it reads in every theme.
import { type CellFormat, type NumberFormat, type SheetFill, tidyFormat } from "@hearth/core";
import { isNumber } from "./grid.ts";

export type Align = NonNullable<CellFormat["align"]>;

/** A change to cells' formats: a part set to null comes off. */
export type FormatPatch = { [K in keyof CellFormat]?: CellFormat[K] | null };

/** Formats with `patch` put on each of `refs`; a cell left with nothing has no entry. */
export function applyFormat(
  formats: Record<string, CellFormat>,
  refs: string[],
  patch: FormatPatch,
): Record<string, CellFormat> {
  const out = { ...formats };
  for (const ref of refs) {
    const next: Record<string, unknown> = { ...out[ref] };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete next[k];
      else next[k] = v;
    }
    const kept = tidyFormat(next as CellFormat);
    if (kept) out[ref] = kept;
    else delete out[ref];
  }
  return out;
}

/**
 * Whether Bold (or Italic) turns it on: off only when every cell in the range has it already, so a
 * range with some bold and some not turns all bold, as in Excel and Google Sheets.
 */
export const turnsOn = (
  formats: Record<string, CellFormat>,
  refs: string[],
  part: "bold" | "italic",
) => !refs.every((ref) => formats[ref]?.[part]);

/** The number formats, in the order the menu offers them; Automatic is none. */
export const NUMBER_CHOICES: { value: NumberFormat | null; label: string; example: string }[] = [
  { value: null, label: "Automatic", example: "As typed" },
  { value: "number", label: "Number", example: "1,200.00" },
  { value: "currency", label: "Currency", example: "$1,200.00" },
  { value: "percent", label: "Percent", example: "15%" },
  { value: "date", label: "Date", example: "Oct 27, 2026" },
];
export const numberLabel = (n?: NumberFormat) =>
  NUMBER_CHOICES.find((c) => c.value === (n ?? null))!.label;

/** Each fill's colour in the theme: one of its chart colours, or its own red and grey. */
const FILL_INK: Record<SheetFill, string> = {
  red: "var(--color-danger)",
  orange: "var(--color-chart-2)",
  yellow: "var(--color-chart-6)",
  green: "var(--color-chart-3)",
  blue: "var(--color-chart-1)",
  purple: "var(--color-chart-5)",
  gray: "var(--color-ink-subtle)",
};
/** A fill as it's drawn behind a cell's text: a tint, so the text stays readable on it. */
export const fillTint = (fill: SheetFill) =>
  `color-mix(in oklab, ${FILL_INK[fill]} 24%, transparent)`;
/** A fill as its swatch shows it. */
export const fillSwatch = (fill: SheetFill) => FILL_INK[fill];

const SELECTED = "color-mix(in oklab, var(--color-jarvis) 10%, transparent)";
const layer = (color: string) => `linear-gradient(${color}, ${color})`;

/**
 * A cell's look. Text sits on the side its format says, or as a spreadsheet puts it: numbers and
 * dates on the right. Its background is its fill, with the selection over it, on the panel's own
 * colour when it's frozen, so what scrolls under it doesn't show through.
 */
export function cellStyle(
  f: CellFormat | undefined,
  value: string,
  o: { selected?: boolean; frozen?: boolean } = {},
): Record<string, string | undefined> {
  const right = isNumber(value) || (f?.number === "date" && value !== "");
  const layers = [
    o.selected ? layer(SELECTED) : null,
    f?.fill ? layer(fillTint(f.fill)) : null,
    o.frozen ? "var(--color-panel)" : null,
  ].filter(Boolean);
  return {
    "font-weight": f?.bold ? "600" : undefined,
    "font-style": f?.italic ? "italic" : undefined,
    "text-align": f?.align ?? (right ? "right" : undefined),
    background: layers.length ? layers.join(", ") : undefined,
  };
}
