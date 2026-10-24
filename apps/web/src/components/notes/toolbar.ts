// The toolbar over what you select in a note: bold, italic, strike and code, a link, an @ link to
// a record, Turn into (a heading, a list, a quote) and Ask Pip. Each button writes markdown, as the
// keys do (keys.ts), and none takes the focus from the note, so the selection stays. It waits
// while the mouse is still down making the selection, and goes when you click out of the note.

import { startCompletion } from "@codemirror/autocomplete";
import { type EditorState, StateEffect, StateField, type TransactionSpec } from "@codemirror/state";
import {
  EditorView,
  showTooltip,
  type Tooltip,
  type TooltipView,
  ViewPlugin,
} from "@codemirror/view";
import { JARVIS_ENTITY_ID, newMentionId, renderMention } from "@hearth/core";
import { keyLabel } from "../../lib/keys.ts";
import {
  type InlineMark,
  kindOf,
  type LineKind,
  makeLink,
  setLineKind,
  toggleMark,
} from "../../lib/noteFormat.ts";
import { type IconName, iconElement } from "../icons.tsx";

const MARKS: [IconName, string, InlineMark, string][] = [
  ["bold", "Bold", "**", "mod+b"],
  ["italic", "Italic", "*", "mod+i"],
  ["strikethrough", "Strike", "~~", "mod+shift+x"],
  ["code", "Code", "`", "mod+e"],
];

/** What a line can be turned into, by name, with its icon (the / menu offers the same). */
export const KINDS: [LineKind, string, IconName][] = [
  ["text", "Text", "type"],
  ["h1", "Heading 1", "heading-1"],
  ["h2", "Heading 2", "heading-2"],
  ["h3", "Heading 3", "heading-3"],
  ["bullet", "Bulleted list", "list"],
  ["number", "Numbered list", "list-ordered"],
  ["check", "Checklist", "list-todo"],
  ["quote", "Quote", "text-quote"],
];

const setDragging = StateEffect.define<boolean>();
/** Whether the mouse is down, making a selection. */
const dragging = StateField.define<boolean>({
  create: () => false,
  update: (on, tr) => tr.effects.reduce((v, e) => (e.is(setDragging) ? e.value : v), on),
});
const setFocused = StateEffect.define<boolean>();
/** Whether you're in the note: out of it, its selection stays but the bar goes. */
const focused = StateField.define<boolean>({
  create: () => false,
  update: (on, tr) => tr.effects.reduce((v, e) => (e.is(setFocused) ? e.value : v), on),
});
const onFocus = EditorView.focusChangeEffect.of((_s, focusing) => setFocused.of(focusing));

function tool(label: string, run: () => void, icon?: IconName, text?: string) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cm-note-tool";
  b.setAttribute("aria-label", label);
  b.title = label;
  if (icon) b.append(iconElement(icon));
  if (text) b.append(text);
  // Pressed without taking the focus: the note keeps its selection.
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = run;
  return b;
}

const gap = () => Object.assign(document.createElement("span"), { className: "cm-note-gap" });

/** The selection's words as the start of an @ link, so the @ list finds what they name. */
function mention(view: EditorView) {
  const r = view.state.selection.main;
  const words = view.state.sliceDoc(r.from, r.to).trim().slice(0, 40);
  view.dispatch({
    changes: { from: r.from, to: r.to, insert: `@${words}` },
    selection: { anchor: r.from + 1 + words.length },
  });
  view.focus();
  startCompletion(view);
}

/** @Pip after the selection, with the caret after it for the question. */
function askPip(view: EditorView) {
  const at = view.state.selection.main.to;
  const chip = renderMention({
    type: "agent",
    id: JARVIS_ENTITY_ID,
    label: "Pip",
    mid: newMentionId(),
  });
  const insert = ` ${chip} `;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length } });
  view.focus();
}

function createBar(view: EditorView): TooltipView {
  const dom = document.createElement("div");
  dom.className = "cm-note-bar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Format");
  const act = (f: (s: EditorState) => TransactionSpec) => () => {
    view.dispatch(f(view.state));
    view.focus();
  };
  for (const [icon, name, mark, keys] of MARKS)
    dom.append(
      tool(
        `${name} (${keyLabel(keys)})`,
        act((s) => toggleMark(s, mark)),
        icon,
      ),
    );
  dom.append(
    gap(),
    tool("Link", act(makeLink), "link"),
    tool("Link a record", () => mention(view), "at-sign"),
  );

  const menu = document.createElement("div");
  menu.className = "cm-note-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const turn = tool("Turn into", () => {
    menu.hidden = !menu.hidden;
    turn.setAttribute("aria-expanded", String(!menu.hidden));
  });
  turn.setAttribute("aria-haspopup", "menu");
  turn.setAttribute("aria-expanded", "false");
  const now = document.createElement("span");
  turn.append(now, iconElement("chevron-down", 14));
  for (const [k, name, icon] of KINDS) {
    const item = tool(
      name,
      act((s) => setLineKind(s, k, false)),
      icon,
      name,
    );
    item.setAttribute("role", "menuitem");
    item.addEventListener("click", () => {
      menu.hidden = true;
    });
    menu.append(item);
  }
  const pip = tool("Ask Pip about this", () => askPip(view), undefined, "Ask Pip");
  pip.prepend(Object.assign(document.createElement("span"), { className: "cm-note-pip" }));
  dom.append(gap(), turn, gap(), pip, menu);

  /** Turn into says what the line is now. */
  const show = () => {
    const kind = kindOf(view.state.doc.lineAt(view.state.selection.main.from).text);
    now.textContent = KINDS.find(([k]) => k === kind)?.[1] ?? "Text";
  };
  show();
  return {
    dom,
    offset: { x: 0, y: 8 },
    update(u) {
      if (u.selectionSet || u.docChanged) show();
    },
  };
}

function barFor(state: EditorState): readonly Tooltip[] {
  const r = state.selection.main;
  if (r.empty || state.readOnly || state.field(dragging) || !state.field(focused)) return [];
  return [{ pos: r.from, end: r.to, above: true, create: createBar }];
}

const bar = StateField.define<readonly Tooltip[]>({
  create: barFor,
  update: (tips, tr) =>
    tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setDragging) || e.is(setFocused))
      ? barFor(tr.state)
      : tips,
  provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
});

/** Tells the bar when the mouse goes down in the note and comes up anywhere. */
const pointer = ViewPlugin.define((view) => {
  const down = (e: MouseEvent) => {
    if (e.button === 0) view.dispatch({ effects: setDragging.of(true) });
  };
  const up = () => {
    if (view.state.field(dragging)) view.dispatch({ effects: setDragging.of(false) });
  };
  view.contentDOM.addEventListener("mousedown", down);
  document.addEventListener("mouseup", up);
  return {
    destroy() {
      view.contentDOM.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up);
    },
  };
});

export const selectionBar = [dragging, focused, onFocus, bar, pointer];
