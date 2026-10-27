// A spreadsheet (PLAN.md section 8.5): a grid of cells with a formula bar, a formatting toolbar and
// sheet tabs. Type to fill a cell, = for a formula; arrows, Tab and Enter move; Ctrl+C and Ctrl+V
// copy and paste with Excel and Google Sheets; Ctrl+B and Ctrl+I bold and slant the selection.

import { cellName, columnName, parseCell } from "@hearth/core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { PaneHeader } from "../components/ui.tsx";
import { useAction } from "../lib/query.ts";
import { cellStyle, turnsOn } from "./format.ts";
import { clampPos, fromTsv, inRange, type Pos, rangeOf, refsIn, toTsv } from "./grid.ts";
import { Header } from "./Header.tsx";
import { createSheet } from "./state.ts";
import { Tabs } from "./Tabs.tsx";
import { Toolbar } from "./Toolbar.tsx";

const WIDTH = 96;
/** Each row's height, and the column letters' row above them, in pixels (h-6). */
const ROW = 24;
/** The row numbers' column (w-10). */
const ROW_NUMBERS = 40;

export function SheetGrid(props: { id: string; pane: number }) {
  const s = createSheet(props.id);
  const [tab, setTab] = createSignal(0);
  const [cur, setCur] = createSignal<Pos>({ row: 1, col: 1 });
  const [anchor, setAnchor] = createSignal<Pos>({ row: 1, col: 1 });
  const [editing, setEditing] = createSignal<"cell" | "bar" | null>(null);
  const [draft, setDraft] = createSignal("");
  let keys: HTMLInputElement | undefined;
  let scroller!: HTMLDivElement;

  // Another screen or Jarvis saved it: take it in (the sheet keeps unsaved edits).
  const remote = useAction<{ version: number }>("sheet.get", () => ({ id: props.id }));
  createEffect(
    on(
      () => remote.data?.version,
      () => void s.load(),
      { defer: true },
    ),
  );
  onMount(() => void s.load());
  onCleanup(() => void s.flush());

  const sheet = () => s.book.sheets[Math.min(tab(), s.book.sheets.length - 1)]!;
  const raw = (ref: string) => sheet().cells[ref] ?? "";
  const shown = (ref: string) => s.results()[tab()]?.[ref] ?? raw(ref);
  const range = () => rangeOf(anchor(), cur());
  const selected = createMemo(() => refsIn(range()));
  const width = (col: number) => sheet().widths[columnName(col)] ?? WIDTH;
  const freeze = () => sheet().freeze ?? { rows: 0, cols: 0 };
  /** How far from the left a frozen column stays, or null when it scrolls. */
  const frozenAt = (col: number) => {
    if (col > freeze().cols) return null;
    let left = ROW_NUMBERS;
    for (let c = 1; c < col; c++) left += width(c);
    return left;
  };

  // Show what's used, plus room to grow into.
  const used = createMemo(() => {
    let rows = 0;
    let cols = 0;
    for (const ref of Object.keys(sheet().cells)) {
      const at = parseCell(ref);
      if (at) {
        rows = Math.max(rows, at.row);
        cols = Math.max(cols, at.col);
      }
    }
    return { rows, cols };
  });
  const rows = () => Math.min(500, Math.max(50, used().rows + 20, cur().row + 10));
  const cols = () => Math.min(52, Math.max(12, used().cols + 4, cur().col + 3));
  const rowList = createMemo(() => Array.from({ length: rows() }, (_, i) => i + 1));
  const colList = createMemo(() => Array.from({ length: cols() }, (_, i) => i + 1));

  const focusGrid = () => queueMicrotask(() => keys?.focus({ preventScroll: true }));
  createEffect(on(cur, () => editing() !== "bar" && focusGrid()));
  createEffect(
    on(cur, (p) => {
      const el = scroller?.querySelector<HTMLElement>(`[data-cell="${cellName(p.row, p.col)}"]`);
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }),
  );

  const move = (dr: number, dc: number, extend = false) => {
    const next = clampPos({ row: cur().row + dr, col: cur().col + dc });
    setCur(next);
    if (!extend) setAnchor(next);
  };
  const select = (p: Pos, extend = false) => {
    setCur(p);
    if (!extend) setAnchor(p);
  };
  const startEdit = (from: "cell" | "bar", text = raw(cellName(cur().row, cur().col))) => {
    setDraft(text);
    setEditing(from);
  };
  const commit = () => {
    if (!editing()) return;
    s.set(tab(), { [cellName(cur().row, cur().col)]: draft() });
    setEditing(null);
  };
  const cancel = () => {
    setEditing(null);
    focusGrid();
  };
  const toggle = (part: "bold" | "italic") =>
    s.format(tab(), selected(), { [part]: turnsOn(sheet().formats, selected(), part) || null });

  function onKey(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    // Bold and italic work while typing in a cell too: they're the cell's, not its words'.
    const key = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && (key === "b" || key === "i")) {
      e.preventDefault();
      toggle(key === "b" ? "bold" : "italic");
      return;
    }
    if (editing()) {
      if (e.key === "Enter") {
        e.preventDefault();
        commit();
        move(e.shiftKey ? -1 : 1, 0);
      } else if (e.key === "Tab") {
        e.preventDefault();
        commit();
        move(0, e.shiftKey ? -1 : 1);
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
      return;
    }
    const steps: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
      PageUp: [-20, 0],
      PageDown: [20, 0],
    };
    const step = steps[e.key];
    if (step) {
      e.preventDefault();
      const far = mod ? 500 : 1;
      move(step[0] * far, step[1] * far, e.shiftKey);
    } else if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      if (e.key === "Tab") move(0, e.shiftKey ? -1 : 1);
      else move(e.shiftKey ? -1 : 1, 0);
    } else if (e.key === "F2") {
      e.preventDefault();
      startEdit("cell");
    } else if (e.key === "Delete" || e.key === "Backspace") {
      // What's in the cells goes; how they look stays, as in any spreadsheet.
      e.preventDefault();
      s.set(tab(), Object.fromEntries(selected().map((r) => [r, ""])));
    } else if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) s.redo();
      else s.undo();
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      s.redo();
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setAnchor({ row: 1, col: 1 });
      setCur({ row: used().rows || 1, col: used().cols || 1 });
    }
  }

  const clipboard = (e: ClipboardEvent, cut = false) => {
    if (editing()) return;
    e.preventDefault();
    e.clipboardData?.setData("text/plain", toTsv(range(), raw));
    if (cut) s.set(tab(), Object.fromEntries(selected().map((r) => [r, ""])));
  };
  const paste = (e: ClipboardEvent) => {
    if (editing()) return;
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    const r = range();
    if (text) s.set(tab(), fromTsv(text, { row: r.top, col: r.left }));
  };

  const curRef = () => cellName(cur().row, cur().col);
  // A new spreadsheet shows its name as the hint, so typing a name replaces it.
  const name = () => (s.title() === "Untitled spreadsheet" ? "" : s.title());

  return (
    <div class="flex h-full flex-col">
      <PaneHeader
        title={
          <input
            class="w-full bg-transparent"
            aria-label="Spreadsheet name"
            value={name()}
            placeholder="Untitled spreadsheet"
            readOnly={!s.loaded()}
            onChange={(e) => void s.rename(e.currentTarget.value.trim() || "Untitled spreadsheet")}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          />
        }
        record={{ id: props.id, type: "spreadsheet", trashed: s.gone() }}
        sub={
          s.problem() ??
          (s.saving() ? "Saving…" : "Type to fill a cell · = starts a formula · F2 edits")
        }
      />
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-2 py-1 text-sm">
        <div class="flex min-w-48 flex-1 items-center gap-2">
          <span class="w-14 shrink-0 text-center font-mono text-xs text-muted">{curRef()}</span>
          <span class="text-faint">ƒx</span>
          <input
            class="min-w-0 flex-1 rounded bg-sunk px-2 py-1 font-mono text-xs"
            aria-label="Cell contents"
            value={editing() ? draft() : raw(curRef())}
            // Before the first read the screen is a blank workbook, not Hearth's: nothing to edit.
            readOnly={!s.loaded()}
            onFocus={() =>
              s.loaded() && editing() !== "bar" && startEdit("bar", editing() ? draft() : undefined)
            }
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={onKey}
            onBlur={() => editing() === "bar" && commit()}
          />
        </div>
        <Toolbar sheet={s} tab={tab()} refs={selected()} at={curRef()} done={focusGrid} />
      </div>
      <div ref={scroller} class="relative flex-1 overflow-auto" data-sheet-grid>
        <Show
          when={s.loaded()}
          fallback={<p class="p-4 text-sm text-muted">{s.gone() ? "" : "Loading…"}</p>}
        >
          <table
            class="border-separate border-spacing-0 text-sm"
            style={{
              "table-layout": "fixed",
              // Moving to a cell scrolls it clear of the rows and columns that stay put.
              "--frozen-top": `${ROW * (1 + freeze().rows)}px`,
              "--frozen-left": `${frozenAt(freeze().cols + 1) ?? ROW_NUMBERS}px`,
            }}
          >
            <Header
              sheet={s}
              tab={tab()}
              cols={colList()}
              width={width}
              range={range()}
              frozenAt={frozenAt}
              frozenCols={freeze().cols}
            />
            <tbody>
              <For each={rowList()}>
                {(r) => {
                  const top = () => (r <= freeze().rows ? ROW * r : null);
                  return (
                    <tr>
                      <th
                        class="sticky left-0 border-r border-b border-line bg-sunk px-1 text-right text-xs font-normal text-muted"
                        // A frozen row's number stays over the numbers that scroll under it.
                        classList={{
                          "z-10": top() === null,
                          "z-20": top() !== null,
                          "border-b-border-strong": r === freeze().rows,
                        }}
                        style={{ top: top() === null ? undefined : `${top()}px` }}
                      >
                        {r}
                      </th>
                      <For each={colList()}>
                        {(c) => {
                          const ref = cellName(r, c);
                          const here = () => cur().row === r && cur().col === c;
                          const value = () => shown(ref);
                          const left = () => frozenAt(c);
                          const stuck = () => top() !== null || left() !== null;
                          return (
                            <td
                              data-cell={ref}
                              class="relative h-6 max-w-0 scroll-mt-(--frozen-top) scroll-ml-(--frozen-left) truncate border-r border-b border-line px-1"
                              classList={{
                                "outline outline-2 -outline-offset-2 outline-jarvis": here(),
                                // A darker line where what stays put meets what scrolls.
                                "border-b-border-strong": r === freeze().rows,
                                "border-r-border-strong": c === freeze().cols,
                              }}
                              style={{
                                ...cellStyle(sheet().formats?.[ref], value(), {
                                  selected: inRange(range(), r, c) && !here(),
                                  frozen: stuck(),
                                }),
                                position: stuck() ? "sticky" : undefined,
                                top: top() === null ? undefined : `${top()}px`,
                                left: left() === null ? undefined : `${left()}px`,
                                // Over the cells that scroll under them; a corner over both.
                                "z-index": stuck()
                                  ? String(top() !== null && left() !== null ? 2 : 1)
                                  : undefined,
                              }}
                              onMouseDown={(e) => {
                                if (e.button !== 0) return;
                                e.preventDefault();
                                if (editing()) commit();
                                select({ row: r, col: c }, e.shiftKey);
                                focusGrid();
                              }}
                              onMouseEnter={(e) =>
                                e.buttons === 1 && select({ row: r, col: c }, true)
                              }
                              onDblClick={() => {
                                startEdit("cell");
                                focusGrid();
                              }}
                            >
                              {here() && editing() === "cell" ? "" : value()}
                              <Show when={here()}>
                                <input
                                  ref={keys}
                                  class="absolute inset-0 h-full w-full bg-panel px-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset"
                                  classList={{
                                    "pointer-events-none opacity-0": editing() !== "cell",
                                  }}
                                  aria-label={`Cell ${ref}`}
                                  value={editing() === "cell" ? draft() : ""}
                                  onInput={(e) => {
                                    // Read it first: starting the edit re-renders the input's value.
                                    const text = e.currentTarget.value;
                                    setDraft(text);
                                    setEditing("cell");
                                  }}
                                  onKeyDown={onKey}
                                  onCopy={(e) => clipboard(e)}
                                  onCut={(e) => clipboard(e, true)}
                                  onPaste={paste}
                                  onBlur={() => editing() === "cell" && commit()}
                                />
                              </Show>
                            </td>
                          );
                        }}
                      </For>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
      <Tabs
        sheet={s}
        tab={tab()}
        onTab={(i) => {
          setTab(i);
          select({ row: 1, col: 1 });
        }}
      />
    </div>
  );
}
