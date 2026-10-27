// What you've typed on the page, for whether a reload would lose it (version.ts wouldLoseWork).
// Only your own input counts, as the browser marks it (a trusted event): what Nook put in a field
// itself (a draft brought back, an address filled in, a name to edit) isn't yours to lose, or an
// update could wait on it for good.

/** Typing this recently still counts as typing: an update waits for a pause. */
export const TYPING_MS = 10_000;

/** A field typed into: an input or a textarea. */
export type Field = { value: string; defaultValue: string };

export interface Typing {
  /** You typed, in a field or anywhere else (a note, a card), within the last TYPING_MS. */
  recently(): boolean;
  /** You typed in `field`, and it holds something other than what it held before you did. */
  changed(field: Field): boolean;
}

const isField = (t: EventTarget | null): t is EventTarget & Field =>
  t !== null &&
  typeof (t as Partial<Field>).value === "string" &&
  typeof (t as Partial<Field>).defaultValue === "string";

/**
 * Watches what you type on `win`, from now on: when you last did, and for each field you typed
 * in, what it held before your first key there (Nook's text, or nothing). Seen first, before
 * anything on the page can stop it going further.
 */
export function watchTyping(win: EventTarget, now: () => number = Date.now): Typing {
  let last = Number.NEGATIVE_INFINITY;
  const before = new WeakMap<object, string>();
  // As a key lands, the field still holds what it had.
  const starting = (e: Event) => {
    if (e.isTrusted && isField(e.target) && !before.has(e.target))
      before.set(e.target, e.target.value);
  };
  const typed = (e: Event) => {
    if (!e.isTrusted) return;
    last = now();
    // Input with nothing said first (the browser filling in a sign-in, say): what the field
    // came with is what it held.
    if (isField(e.target) && !before.has(e.target)) before.set(e.target, e.target.defaultValue);
  };
  win.addEventListener("beforeinput", starting, { capture: true });
  win.addEventListener("input", typed, { capture: true });
  return {
    recently: () => now() - last < TYPING_MS,
    changed: (f) => before.has(f) && f.value !== before.get(f),
  };
}

/** What you've typed since the page's code loaded: watched before anything is drawn. */
export const typing: Typing = watchTyping(
  typeof window === "undefined" ? new EventTarget() : window,
);
