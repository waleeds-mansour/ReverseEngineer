// A note drawn as what it says (lib/notePreview.ts decides how): marks faint on the lines you're
// on and hidden on the rest, bullets for dashes, a rule for ---. Ctrl+click (Cmd on a Mac) opens a
// link; a plain click puts the caret in it, to edit. Pictures, tables and link cards are drawn too
// (blocks.ts), and pictures pasted or dropped in go to Nook first (pictures.ts).

import { syntaxTree } from "@codemirror/language";
import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { IS_MAC } from "../../lib/keys.ts";
import { activeLines, lookOf } from "../../lib/notePreview.ts";
import { noteBlocks } from "./blocks.ts";
import { notePictures } from "./pictures.ts";

const BULLETS = ["•", "◦", "▪"];

class Bullet extends WidgetType {
  constructor(readonly depth: number) {
    super();
  }
  eq(o: Bullet) {
    return o.depth === this.depth;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-bullet";
    el.textContent = BULLETS[this.depth % BULLETS.length]!;
    return el;
  }
}

class Rule extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-md-hr";
    el.setAttribute("aria-hidden", "true");
    return el;
  }
}

const RULE = Decoration.replace({ widget: new Rule() });
const HIDE = Decoration.replace({});
const lines = new Map<string, Decoration>();
const marks = new Map<string, Decoration>();
const lineDeco = (cls: string) =>
  lines.get(cls) ?? lines.set(cls, Decoration.line({ class: cls })).get(cls)!;
const markDeco = (cls: string) =>
  marks.get(cls) ?? marks.set(cls, Decoration.mark({ class: cls })).get(cls)!;
const OPEN = `${IS_MAC ? "Cmd" : "Ctrl"}+click to open`;

function decorate(view: EditorView, hide: boolean): DecorationSet {
  const { from, to } = view.viewport;
  const looks = lookOf(view.state, from, to, {
    hide,
    active: activeLines(view.state, view.hasFocus),
  });
  const out: Range<Decoration>[] = [];
  for (const l of looks) {
    if (l.kind === "line") out.push(lineDeco(l.cls).range(l.at));
    else if (l.kind === "hide") out.push(HIDE.range(l.from, l.to));
    else if (l.kind === "rule") out.push(RULE.range(l.from, l.to));
    else if (l.kind === "bullet")
      out.push(Decoration.replace({ widget: new Bullet(l.depth) }).range(l.from, l.to));
    else if (l.href)
      out.push(
        Decoration.mark({
          class: l.cls,
          attributes: { "data-href": l.href, title: OPEN },
        }).range(l.from, l.to),
      );
    else out.push(markDeco(l.cls).range(l.from, l.to));
  }
  return Decoration.set(out, true);
}

/** Which lines are being edited, as one string, to tell when the caret moved to another line. */
const activeKey = (u: ViewUpdate) => [...activeLines(u.state, u.view.hasFocus)].join(",");

function plugin(hide: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      active: string;
      constructor(view: EditorView) {
        this.decorations = decorate(view, hide);
        this.active = "";
      }
      update(u: ViewUpdate) {
        const key = activeKey(u);
        if (
          u.docChanged ||
          u.viewportChanged ||
          key !== this.active ||
          syntaxTree(u.startState) !== syntaxTree(u.state)
        ) {
          this.active = key;
          this.decorations = decorate(u.view, hide);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}

/** Opens a link the note holds, in a new tab: only the web, mail and Nook's files (notePreview). */
const openLinks = EditorView.domEventHandlers({
  mousedown(e) {
    if (!(IS_MAC ? e.metaKey : e.ctrlKey) || !(e.target instanceof Element)) return false;
    const href = e.target.closest("[data-href]")?.getAttribute("data-href");
    if (!href) return false;
    e.preventDefault();
    window.open(href, "_blank", "noopener,noreferrer");
    return true;
  },
});

/** The note's look: `hide` false is the Markdown button, every mark showing and nothing drawn. */
export function notePreview(hide: boolean): Extension {
  return [plugin(hide), openLinks, noteBlocks(hide), notePictures];
}
