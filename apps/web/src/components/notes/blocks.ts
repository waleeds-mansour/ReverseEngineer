// A note's pictures, tables and link cards, drawn in place of their markdown (lib/noteBlocks.ts
// decides which). A picture kept in Nook shows sized to the column and opens full size on a click.
// A table is a grid: a click on a cell puts the caret in it, and the table shows its markdown to
// edit, with Tab between cells (keys.ts). A line that's only a web address is a card with the
// page's title, opened by a click. Click beside one, or arrow up or down onto it, to edit what's
// written there.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  Facet,
  Prec,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  type Command,
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  WidgetType,
} from "@codemirror/view";
import { blocksOf, type Cell } from "../../lib/noteBlocks.ts";
import { activeLines } from "../../lib/notePreview.ts";
import { type Align, splitRow } from "../../lib/noteTable.ts";
import { iconElement } from "../icons.tsx";
import { titleOf } from "./titles.ts";

/** Whether marks hide off the caret's lines. False is the Markdown button: nothing is drawn. */
const hiding = Facet.define<boolean, boolean>({ combine: (v) => v[0] ?? true });

const open = (url: string) => void window.open(url, "_blank", "noopener,noreferrer");

/** Puts the caret at `pos`, in the note, so what's written there shows to edit. */
function caretTo(view: EditorView, pos: number) {
  view.dispatch({ selection: { anchor: Math.min(pos, view.state.doc.length) } });
  view.focus();
}

/** Opens what `act` says on a click; a click beside it, still on its line, is to edit it. */
function clicks(view: EditorView, box: HTMLElement, hit: HTMLElement, act: () => void) {
  box.onmousedown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (!hit.contains(e.target as Node)) caretTo(view, view.posAtDOM(box));
  };
  hit.onclick = (e) => {
    e.preventDefault();
    act();
  };
}

class Picture extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly whole: boolean,
  ) {
    super();
  }
  eq(o: Picture) {
    return o.src === this.src && o.alt === this.alt && o.whole === this.whole;
  }
  get estimatedHeight() {
    return this.whole ? 240 : -1;
  }
  toDOM(view: EditorView) {
    const box = document.createElement(this.whole ? "div" : "span");
    box.className = this.whole ? "cm-note-picture" : "cm-note-picture cm-note-picture-inline";
    const img = document.createElement("img");
    img.src = this.src;
    img.alt = this.alt;
    img.title = "Click to open it full size";
    img.draggable = false;
    // Its height is known once it's loaded: the editor measures again.
    img.onload = () => view.requestMeasure();
    // Trashed, or not on this PC: say so, where it was.
    img.onerror = () => {
      const gone = document.createElement("span");
      gone.className = "cm-note-picture-gone";
      gone.textContent = `${this.alt || "A picture"} isn't in Nook any more.`;
      img.replaceWith(gone);
      view.requestMeasure();
    };
    box.append(img);
    clicks(view, box, img, () => open(this.src));
    return box;
  }
}

class Grid extends WidgetType {
  readonly key: string;
  constructor(
    readonly rows: Cell[][],
    readonly align: Align[],
  ) {
    super();
    this.key = JSON.stringify([rows, align]);
  }
  eq(o: Grid) {
    return o.key === this.key;
  }
  get estimatedHeight() {
    return this.rows.length * 35 + 8;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-note-grid";
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    const body = table.createTBody();
    this.rows.forEach((row, r) => {
      const tr = r === 0 ? head : body.insertRow();
      row.forEach((cell, c) => {
        const td = document.createElement(r === 0 ? "th" : "td");
        td.textContent = cell.text;
        const align = this.align[c];
        if (align) td.style.textAlign = align;
        // Where it is now, not when it was drawn: the note may have changed above it since.
        td.onmousedown = (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          caretTo(view, view.posAtDOM(box) + cell.at);
        };
        tr.append(td);
      });
    });
    box.append(table);
    box.onmousedown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      caretTo(view, view.posAtDOM(box));
    };
    return box;
  }
}

class Card extends WidgetType {
  constructor(
    readonly url: string,
    readonly label: string,
  ) {
    super();
  }
  eq(o: Card) {
    return o.url === this.url && o.label === this.label;
  }
  get estimatedHeight() {
    return 64;
  }
  toDOM(view: EditorView) {
    const box = document.createElement("div");
    box.className = "cm-note-card-line";
    const site = new URL(this.url).hostname.replace(/^www\./, "");
    const card = document.createElement("a");
    card.className = "cm-note-card";
    card.href = this.url;
    card.title = `Open ${this.url}`;
    const tile = document.createElement("span");
    tile.className = "cm-note-card-icon";
    tile.append(iconElement(this.label ? "image" : "globe"));
    const words = document.createElement("span");
    words.className = "cm-note-card-words";
    const title = document.createElement("span");
    title.className = "cm-note-card-title";
    title.textContent = this.label || this.url.replace(/^https?:\/\/(www\.)?/, "");
    const where = document.createElement("span");
    where.className = "cm-note-card-site";
    where.textContent = site;
    words.append(title, where);
    card.append(tile, words);
    box.append(card);
    clicks(view, box, card, () => open(this.url));
    if (!this.label)
      void titleOf(this.url).then((t) => {
        if (!t) return;
        title.textContent = t;
        view.requestMeasure();
      });
    return box;
  }
}

const setFocus = StateEffect.define<boolean>();

interface Drawn {
  focused: boolean;
  /** The lines being edited, as one string, to tell when the caret moved to another line. */
  active: string;
  deco: DecorationSet;
}

function draw(state: EditorState, focused: boolean): Drawn {
  const active = activeLines(state, focused);
  const out: Range<Decoration>[] = [];
  for (const b of blocksOf(state, { hide: state.facet(hiding), active })) {
    if (b.kind === "picture" && !b.whole) {
      const widget = new Picture(b.src, b.alt, false);
      out.push(Decoration.replace({ widget }).range(b.from, b.to));
      continue;
    }
    const widget =
      b.kind === "picture"
        ? new Picture(b.src, b.alt, true)
        : b.kind === "grid"
          ? new Grid(b.rows, b.align)
          : new Card(b.url, b.label);
    // Its whole lines: a block takes them, spaces and all.
    const from = state.doc.lineAt(b.from).from;
    const to = state.doc.lineAt(b.to).to;
    out.push(Decoration.replace({ widget, block: true }).range(from, to));
  }
  return { focused, active: [...active].join(","), deco: Decoration.set(out, true) };
}

// A field, not a view plugin: only a field may draw a block over whole lines. It's the same one
// whichever way the Markdown button is, so turning that over keeps what it knows (the focus).
const drawn = StateField.define<Drawn>({
  create: (state) => draw(state, false),
  update(v, tr) {
    let focused = v.focused;
    for (const e of tr.effects) if (e.is(setFocus)) focused = e.value;
    const active = [...activeLines(tr.state, focused)].join(",");
    const same =
      !tr.docChanged &&
      !tr.reconfigured &&
      focused === v.focused &&
      active === v.active &&
      syntaxTree(tr.startState) === syntaxTree(tr.state);
    return same ? v : draw(tr.state, focused);
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const onFocus = EditorView.focusChangeEffect.of((_s, focusing) => setFocus.of(focusing));

/**
 * Up or down onto a drawn line stops there, showing its markdown to edit: CodeMirror would
 * otherwise go past a block as if it weren't there.
 */
function onto(down: boolean): Command {
  return (view) => {
    const { state } = view;
    const sel = state.selection.main;
    if (!sel.empty || state.selection.ranges.length > 1) return false;
    const here = state.doc.lineAt(sel.head);
    const n = here.number + (down ? 1 : -1);
    if (n < 1 || n > state.doc.lines) return false;
    // Within a wrapped line, or onto the next line anyway: as usual.
    const lands = state.doc.lineAt(view.moveVertically(sel, down).head).number;
    if (lands === here.number || lands === n) return false;
    const next = state.doc.line(n);
    const found: Decoration[] = [];
    state.field(drawn).deco.between(next.from, next.to, (from, to, d) => {
      if (d.spec.block && from <= next.from && to >= next.to) found.push(d);
    });
    if (!found[0]) return false;
    // In a table, into the row's first cell, as Tab goes; anything else, its line's start.
    const grid = found[0].spec.widget instanceof Grid;
    const at = next.from + (grid ? (splitRow(next.text)[0]?.to ?? 0) : 0);
    view.dispatch({ selection: { anchor: at }, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

const arrows = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: onto(true) },
    { key: "ArrowUp", run: onto(false) },
  ]),
);

/** Pictures, grids and cards; `hide` false is the Markdown button, and they show as written. */
export function noteBlocks(hide: boolean): Extension {
  return [hiding.of(hide), drawn, onFocus, arrows];
}
