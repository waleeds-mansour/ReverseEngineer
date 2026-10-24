// The / menu: a / at the start of a line lists what it can become (a heading, a list, a quote, a
// code block, a divider) and what can go in (a link, an @ link to a record, a question for Pip).
// Typing after the / narrows it; Enter or a click puts it in, writing the markdown for it.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  startCompletion,
} from "@codemirror/autocomplete";
import type { EditorView } from "@codemirror/view";
import { JARVIS_ENTITY_ID, newMentionId, renderMention } from "@hearth/core";
import { setLineKind } from "../../lib/noteFormat.ts";
import { type IconName, iconElement } from "../icons.tsx";
import { KINDS } from "./toolbar.ts";

/** A / menu entry: its icon, and what it does once the /word is taken out. */
interface SlashItem extends Completion {
  icon: IconName | "pip";
}

/** The markdown each kind is written with, shown beside it so it can be typed instead. */
const TYPED: Record<string, string> = {
  h1: "#",
  h2: "##",
  h3: "###",
  bullet: "-",
  number: "1.",
  check: "[ ]",
  quote: ">",
};

// In this order, not by name: the line kinds first, as Turn into lists them.
const BASIC = { name: "Basic", rank: 0 };
const INSERT = { name: "Insert", rank: 1 };
const PIP = { name: "Pip", rank: 2 };

/** Takes out the /word typed, then writes `insert` there, with the caret `caret` into it. */
function put(view: EditorView, from: number, to: number, insert: string, caret = insert.length) {
  view.dispatch({
    changes: { from: from - 1, to, insert },
    selection: { anchor: from - 1 + caret },
    userEvent: "input.complete",
  });
}

const kinds: SlashItem[] = KINDS.map(([kind, label, icon]) => ({
  label,
  icon,
  detail: TYPED[kind],
  section: BASIC,
  apply: (view, _c, from, to) => {
    put(view, from, to, "");
    view.dispatch(setLineKind(view.state, kind, false));
  },
}));

const blocks: SlashItem[] = [
  {
    label: "Code block",
    icon: "square-code",
    detail: "```",
    section: BASIC,
    apply: (view, _c, from, to) => put(view, from, to, "```\n\n```", 4),
  },
  {
    label: "Divider",
    icon: "minus",
    detail: "---",
    section: BASIC,
    // After a blank line: right under a line of words, --- would make that line a heading.
    apply: (view, _c, from, to) => {
      const line = view.state.doc.lineAt(from);
      const above = line.number > 1 ? view.state.doc.line(line.number - 1).text.trim() : "";
      const insert = `${above ? "\n" : ""}---\n`;
      put(view, from, to, insert);
    },
  },
  {
    label: "Link",
    icon: "link",
    section: INSERT,
    apply: (view, _c, from, to) => put(view, from, to, "[]()", 1),
  },
  {
    label: "Task, note or person",
    icon: "at-sign",
    detail: "@",
    section: INSERT,
    apply: (view, _c, from, to) => {
      put(view, from, to, "@");
      startCompletion(view);
    },
  },
  {
    label: "Ask Pip",
    icon: "pip",
    detail: "@Pip",
    section: PIP,
    apply: (view, _c, from, to) => {
      const chip = renderMention({
        type: "agent",
        id: JARVIS_ENTITY_ID,
        label: "Pip",
        mid: newMentionId(),
      });
      put(view, from, to, `${chip} `);
    },
  },
];

/** Kept in the order written while nothing's typed; a better match still goes first. */
const ITEMS = [...kinds, ...blocks].map((c, i, all) => ({ ...c, boost: all.length - i }));

/** The / menu's entries, when the line so far is just a / and what's typed after it. */
export function slashMenu(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  // Not "/ ": a / and a space is writing, not asking for the menu.
  const m = /^\s*\/(\w[\w ]{0,23})?$/.exec(ctx.state.sliceDoc(line.from, ctx.pos));
  if (!m) return null;
  return { from: ctx.pos - (m[1]?.length ?? 0), options: ITEMS, validFor: /^(\w[\w ]*)?$/ };
}

/** Each entry's icon, drawn before its name; @ suggestions have none. */
export const slashIcon = {
  position: 20,
  render(c: Completion) {
    const icon = (c as Partial<SlashItem>).icon;
    if (!icon) return null;
    const tile = document.createElement("span");
    tile.className = "cm-note-slash-icon";
    tile.append(
      icon === "pip"
        ? Object.assign(document.createElement("span"), { className: "cm-note-pip" })
        : iconElement(icon),
    );
    return tile;
  },
};
