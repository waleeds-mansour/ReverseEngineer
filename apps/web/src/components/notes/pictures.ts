// Pictures and files into a note: paste or drop one, or pick one with the / menu's Image, and
// "Adding…" shows where it goes while it's on its way. Nothing is in the note until Nook has it,
// so your other screens and Pip never see half a file. Then its markdown goes there on a line of
// its own (lib/noteFiles.ts), however the note changed meanwhile, and the note draws the picture
// (blocks.ts). Any other file goes in as a link that downloads it.

import { type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { toast } from "../../lib/live.ts";
import {
  fileMarkdown,
  filesIn,
  type NoteFile,
  nameOf,
  PICTURE_TYPES,
  placeFiles,
  upload,
} from "../../lib/noteFiles.ts";

class Adding extends WidgetType {
  constructor(readonly what: string) {
    super();
  }
  eq(o: Adding) {
    return o.what === this.what;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-note-adding";
    el.textContent = `Adding ${this.what}…`;
    return el;
  }
}

const adding = StateEffect.define<{ key: number; at: number; what: string }>({
  map: (v, changes) => ({ ...v, at: changes.mapPos(v.at, -1) }),
});
const added = StateEffect.define<number>();

/** Where files on their way will go: kept in step with every change to the note meanwhile. */
const waiting = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(set, tr) {
    let next = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(adding)) {
        // Before what you type next: the file lands where you put it, your words after it.
        const mark = Decoration.widget({
          widget: new Adding(e.value.what),
          side: -1,
          key: e.value.key,
        });
        next = next.update({ add: [mark.range(e.value.at)] });
      }
      if (e.is(added)) next = next.update({ filter: (_f, _t, d) => d.spec.key !== e.value });
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});
let nextKey = 0;

function whereIs(view: EditorView, key: number): number | null {
  let at: number | null = null;
  view.state.field(waiting).between(0, view.state.doc.length, (from, _to, d) => {
    if (d.spec.key !== key) return;
    at = from;
    return false;
  });
  return at;
}

/** How files came: a paste names a screenshot for when it was pasted; a drop moves no caret. */
type How = "paste" | "drop" | "pick";

/** Sends `files` to Nook one after another, then writes their markdown where they were put. */
async function add(view: EditorView, files: File[], how: How, at: number) {
  const pasted = how === "paste";
  const key = nextKey++;
  const what = files.length === 1 ? nameOf(files[0]!, pasted) : `${files.length} files`;
  view.dispatch({ effects: adding.of({ key, at, what }) });
  const kept: NoteFile[] = [];
  for (const file of files) {
    const name = nameOf(file, pasted);
    try {
      kept.push(await upload(file, name));
    } catch (err) {
      toast.show(`${name}: ${err instanceof Error ? err.message : "not added"}`, "error");
    }
  }
  // The note closed meanwhile: the files are kept in Nook, but there's nowhere to put them.
  if (!view.dom.isConnected) {
    if (kept.length) toast.show(`${what} was kept in Nook, but the note closed before it went in.`);
    return;
  }
  if (!kept.length) return view.dispatch({ effects: added.of(key) });
  // Deleted meanwhile: it's in the trash, and can't be changed until it's restored.
  if (view.state.readOnly) {
    toast.show(`${what} was kept in Nook, but this note can't be changed now.`);
    return view.dispatch({ effects: added.of(key) });
  }
  // Where it was put; if the words around that were deleted meanwhile, where the caret is.
  const where = whereIs(view, key) ?? view.state.selection.main.head;
  const p = placeFiles(view.state.doc, where, kept.map(fileMarkdown), how !== "drop");
  const caret = view.state.selection.main;
  view.dispatch({
    changes: { from: p.from, to: p.to, insert: p.insert },
    effects: added.of(key),
    // Still where you put it: the caret goes under it, so you write on below the picture.
    ...(caret.empty && caret.head === where ? { selection: { anchor: p.caret } } : {}),
    userEvent: "input.paste",
  });
}

/** Opens the file picker for pictures; what's picked goes in at `at`. */
export function pickPictures(view: EditorView, at: number): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = PICTURE_TYPES;
  input.multiple = true;
  input.hidden = true;
  // In the page while it's open, as some browsers want, and gone once it's done.
  input.addEventListener("cancel", () => input.remove());
  input.onchange = () => {
    input.remove();
    const files = [...(input.files ?? [])];
    if (files.length && !view.state.readOnly) void add(view, files, "pick", at);
  };
  document.body.append(input);
  input.click();
}

/**
 * Pasting or dropping files into a note. Words win: a paste with words (Word puts a picture of
 * them beside them) is the words.
 */
export const notePictures: Extension = [
  waiting,
  EditorView.domEventHandlers({
    paste(e, view) {
      const files = filesIn(e.clipboardData);
      if (!files.length || view.state.readOnly) return false;
      e.preventDefault();
      const { from, to } = view.state.selection.main;
      if (to > from) view.dispatch({ changes: { from, to }, userEvent: "delete" });
      void add(view, files, "paste", from);
      return true;
    },
    dragover(e) {
      if (!e.dataTransfer?.types.includes("Files")) return false;
      e.preventDefault();
      return true;
    },
    // CodeMirror would otherwise read a dropped file as text, a picture's bytes and all.
    drop(e, view) {
      const files = filesIn(e.dataTransfer);
      if (!files.length) return false;
      e.preventDefault();
      if (view.state.readOnly) return true;
      const pos =
        view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      // Onto words, it goes under their line rather than between them.
      const line = view.state.doc.lineAt(pos);
      void add(view, files, "drop", line.text.trim() ? line.to : pos);
      return true;
    },
  }),
];
