// How the note editor looks: markdown drawn as what it means (notes/preview.ts says where), the
// selection toolbar and the @ and / menus, in Nook's colours for light and dark.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

const look = EditorView.theme({
  ".cm-md-h1": { fontSize: "1.6em", fontWeight: "700", lineHeight: "1.35" },
  ".cm-md-h2": { fontSize: "1.3em", fontWeight: "650", lineHeight: "1.4" },
  ".cm-md-h3": { fontSize: "1.1em", fontWeight: "600" },
  ".cm-md-quote": {
    color: "var(--color-muted)",
    borderLeft: "2px solid var(--color-line)",
    paddingLeft: "12px",
  },
  ".cm-md-strong": { fontWeight: "650" },
  ".cm-md-em": { fontStyle: "italic" },
  ".cm-md-strike": { textDecoration: "line-through", color: "var(--color-muted)" },
  ".cm-md-code": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    backgroundColor: "var(--color-sunk)",
    borderRadius: "4px",
    padding: "1px 3px",
  },
  ".cm-md-codeblock": {
    fontFamily: "var(--font-mono)",
    fontSize: "0.9em",
    backgroundColor: "var(--color-raised)",
  },
  ".cm-md-link": {
    color: "var(--color-accent-ink)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in srgb, var(--color-accent-ink) 45%, transparent)",
    textUnderlineOffset: "3px",
  },
  ".cm-md-marker": { color: "var(--color-faint)", fontWeight: "400" },
  ".cm-md-ordinal": { color: "var(--color-muted)", fontVariantNumeric: "tabular-nums" },
  ".cm-md-bullet": {
    display: "inline-block",
    width: "0.9em",
    textAlign: "center",
    color: "var(--color-muted)",
  },
  ".cm-md-hr": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--color-line)",
  },
  // The @ popup, in Nook's colors rather than CodeMirror's light grey.
  ".cm-tooltip": {
    backgroundColor: "var(--color-panel)",
    color: "var(--color-ink)",
    border: "1px solid var(--color-line)",
    borderRadius: "8px",
    boxShadow: "var(--elevation-3)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-sans)",
    fontSize: "14px",
    maxHeight: "18rem",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "4px 10px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--color-accent-soft)",
    color: "var(--color-ink)",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
    display: "block",
    padding: "8px 10px 2px",
    border: "none",
    color: "var(--color-muted)",
    fontSize: "11px",
    fontWeight: "650",
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  ".cm-completionDetail": { color: "var(--color-muted)", fontStyle: "normal", marginLeft: "auto" },
  ".cm-note-slash-icon": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "26px",
    height: "26px",
    borderRadius: "6px",
    backgroundColor: "var(--color-sunk)",
    color: "var(--color-muted)",
  },
  // The selection toolbar, and Turn into's list under it.
  ".cm-tooltip.cm-note-bar": {
    display: "flex",
    alignItems: "center",
    gap: "2px",
    padding: "4px",
    overflow: "visible",
  },
  ".cm-note-tool": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    height: "30px",
    minWidth: "30px",
    padding: "0 7px",
    justifyContent: "center",
    borderRadius: "6px",
    color: "var(--color-ink)",
    font: "600 13px var(--font-sans)",
    whiteSpace: "nowrap",
  },
  ".cm-note-tool:hover, .cm-note-tool[aria-expanded=true]": {
    backgroundColor: "var(--color-sunk)",
  },
  ".cm-note-gap": {
    width: "1px",
    height: "18px",
    margin: "0 3px",
    backgroundColor: "var(--color-line)",
  },
  ".cm-note-menu": {
    position: "absolute",
    top: "calc(100% + 4px)",
    left: "0",
    display: "flex",
    flexDirection: "column",
    minWidth: "190px",
    padding: "4px",
    backgroundColor: "var(--color-panel)",
    border: "1px solid var(--color-line)",
    borderRadius: "8px",
    boxShadow: "var(--elevation-3)",
  },
  ".cm-note-menu[hidden]": { display: "none" },
  ".cm-note-menu .cm-note-tool": { justifyContent: "flex-start", fontWeight: "500", gap: "10px" },
  // Pip's mark: its circle with a bright core.
  ".cm-note-pip": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    borderRadius: "50%",
    backgroundColor: "var(--color-jarvis)",
  },
  ".cm-note-pip::after": {
    content: '""',
    width: "38%",
    height: "38%",
    borderRadius: "50%",
    backgroundColor: "var(--color-on-accent)",
  },
});

/** Everything above, as one extension for the editor. */
export const editorLook: Extension = look;
