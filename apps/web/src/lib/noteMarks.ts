// Whether notes show their markdown marks everywhere (the Markdown button, or Ctrl+/), rather than
// only on the line you're on. Kept on this device; every open note follows it.

import { createSignal } from "solid-js";

const KEY = "hearth.notes.marks";

function saved(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

const [marks, setMarks] = createSignal(saved());

export const showMarks = marks;

export function toggleMarks(): void {
  const next = !marks();
  setMarks(next);
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // Not kept (a private window): it still holds until the page reloads.
  }
}
