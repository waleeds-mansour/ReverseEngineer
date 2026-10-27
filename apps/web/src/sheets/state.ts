// One open spreadsheet: the workbook as typed, its results, undo and redo, and saving. Every change
// is saved whole a moment after you stop, kept on this device until Hearth has it, and merged cell
// by cell with anything saved elsewhere meanwhile (Jarvis, another screen): D59. It takes no change
// or new name until it has been read, from Hearth or from a copy kept here: until then the screen
// holds a blank workbook, not Hearth's, and its cells have the same names as Hearth's.

import {
  type CellFormat,
  emptyWorkbook,
  filledWorkbook,
  mergeWorkbook,
  type Results,
  renameSheetRefs,
  type Workbook,
} from "@hearth/core";
import { batch, createMemo, createSignal } from "solid-js";
import { createStore, reconcile, unwrap } from "solid-js/store";
import { action } from "../lib/api.ts";
import { reportError } from "../lib/live.ts";
import { createSaver } from "../lib/wholeSave.ts";
import { type Engine, engine } from "./engine.ts";
import { applyFormat, type FormatPatch, sameFormat } from "./format.ts";

const MAX_UNDO = 100;

const copy = (b: Workbook): Workbook => structuredClone(unwrap(b));

export function createSheet(id: string) {
  const [book, setStore] = createStore<Workbook>(emptyWorkbook());
  // Bumped on every change: working out results reads an untracked copy of the whole workbook.
  const [rev, setRev] = createSignal(0);
  const setBook = (b: Workbook) => {
    setStore(reconcile(b, { key: "id" }));
    setRev((n) => n + 1);
  };
  const [title, setTitle] = createSignal("");
  const [loaded, setLoaded] = createSignal(false);
  const [served, setServed] = createSignal<Results>([]);
  const [calc, setCalc] = createSignal<Engine | null>(null);
  const undo: Workbook[] = [];
  const redo: Workbook[] = [];

  engine()
    .then((e) => setCalc(() => e))
    .catch(reportError);

  // Worked out here once the engine has loaded; until then, what the server worked out.
  const results = createMemo<Results>(() => {
    const e = calc();
    rev();
    if (!e) return served();
    try {
      return e.calc(copy(book));
    } catch (err) {
      reportError(err);
      return served();
    }
  });

  const saver = createSaver<Workbook>({
    id,
    key: `sheet:${id}`,
    noun: "spreadsheet",
    action: "sheet.save",
    input: (data, baseVersion, name) => ({
      id,
      book: data,
      baseVersion,
      ...(name !== undefined ? { title: name } : {}),
    }),
    async get() {
      const r = await action<{
        title: string;
        book: Workbook;
        results: Results;
        version: number;
      }>("sheet.get", { id });
      setServed(r.results);
      return { title: r.title, data: r.book, version: r.version };
    },
    merge: mergeWorkbook,
    // What the screen starts as, not no sheets at all: a cell typed in its "Sheet1" before the
    // first read then doesn't put that name back over the one Hearth's sheet has.
    empty: emptyWorkbook,
    current: () => copy(book),
    show(data, name) {
      batch(() => {
        if (name !== undefined && !saver.renaming()) setTitle(name);
        // A copy kept on this device before sheets had formats has none.
        setBook(filledWorkbook(data));
        setLoaded(true);
      });
    },
  });

  /** Changes the workbook as one undoable step. */
  const change = (fn: (draft: Workbook) => void) => {
    if (!loaded()) return;
    undo.push(copy(book));
    if (undo.length > MAX_UNDO) undo.shift();
    redo.length = 0;
    const next = copy(book);
    fn(next);
    setBook(next);
    saver.changed();
  };

  const put = (
    sheet: number,
    cells: Record<string, string>,
    formats: Record<string, CellFormat | null> = {},
  ) => {
    const s = book.sheets[sheet];
    if (!s) return;
    const sameCells = Object.entries(cells).every(([k, v]) => (s.cells[k] ?? "") === v);
    const sameFormats = Object.entries(formats).every(([k, f]) => sameFormat(s.formats[k], f));
    if (sameCells && sameFormats) return;
    change((d) => {
      const target = d.sheets[sheet]!;
      for (const [k, v] of Object.entries(cells)) {
        if (v === "") delete target.cells[k];
        else target.cells[k] = v;
      }
      for (const [k, f] of Object.entries(formats)) {
        if (f) target.formats[k] = { ...f };
        else delete target.formats[k];
      }
    });
  };

  const swap = (from: Workbook[], to: Workbook[]) => {
    const prev = from.pop();
    if (!prev) return;
    to.push(copy(book));
    setBook(prev);
    saver.changed();
  };

  return {
    book,
    title,
    loaded,
    saving: saver.saving,
    /** It's in the trash: the pane's header says so, and offers Restore. */
    gone: saver.gone,
    /** Why the spreadsheet isn't saved, in plain words, or null; in the trash, what that means. */
    problem() {
      if (!saver.gone()) return saver.problem();
      return loaded()
        ? "Changes made here are kept, and saved once it's restored."
        : "There's nothing to show here until it's restored.";
    },
    results,
    /**
     * Each formula's value among `refs`, as what to type for it alone (Paste values only); none
     * until the engine has loaded.
     */
    values(sheet: number, refs: string[]): Record<string, string> {
      try {
        return calc()?.values(copy(book), sheet, refs) ?? {};
      } catch (err) {
        reportError(err);
        return {};
      }
    },
    /** Reads it from Hearth, keeping what's unsaved here on top. */
    load: saver.load,
    change,
    /** Sets cells on one sheet: "" clears. */
    set: (sheet: number, cells: Record<string, string>) => put(sheet, cells),
    /** Sets cells and their formats on one sheet, as one step to undo: "" or null clears. */
    put,
    /** Formats cells on one sheet, as one step to undo: a part set to null comes off. */
    format(sheet: number, refs: string[], patch: FormatPatch) {
      const s = book.sheets[sheet];
      if (!s) return;
      const now = unwrap(s.formats);
      const next = applyFormat(now, refs, patch);
      if (JSON.stringify(next) === JSON.stringify(now)) return;
      change((d) => {
        d.sheets[sheet]!.formats = structuredClone(next);
      });
    },
    /** Keeps the top `rows` and left `cols` in place while the rest scrolls. */
    setFreeze(sheet: number, rows: number, cols: number) {
      const s = book.sheets[sheet];
      if (!s || (s.freeze.rows === rows && s.freeze.cols === cols)) return;
      change((d) => {
        d.sheets[sheet]!.freeze = { rows, cols };
      });
    },
    /** Renames a sheet, and every formula that points at it. */
    renameSheet(sheet: number, name: string) {
      change((d) => {
        Object.assign(d, renameSheetRefs(d, sheet, name));
      });
    },
    undo: () => swap(undo, redo),
    redo: () => swap(redo, undo),
    rename(t: string) {
      if (!loaded()) return;
      setTitle(t);
      saver.rename(t);
    },
    /** Saves now and stops watching for the page closing (closing the spreadsheet). */
    flush: saver.close,
  };
}

export type Sheet = ReturnType<typeof createSheet>;
