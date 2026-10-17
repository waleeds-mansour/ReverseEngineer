// What a shortcut is called here. Bindings are written one way everywhere (lib/hotkeys.ts: "j",
// "mod+shift+z", "g i", "escape") and shown the way the platform names its keys: Ctrl, Alt, Shift
// and Win on Windows, ⌃ ⌥ ⇧ ⌘ on a Mac, each in the order that platform lists them. Kbd draws a
// shortcut as key caps; a title or a placeholder says it with keyLabel.

/** A Mac (or an iPad with a keyboard), where shortcuts use ⌘ for what Windows does with Ctrl. */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** What "mod" is called on this computer, for hints: ⌘ on a Mac, Ctrl elsewhere. */
export const MOD = IS_MAC ? "⌘" : "Ctrl";

/** Each modifier's name on Windows and on a Mac. "mod" is the one a binding means. */
const MODIFIERS: Record<string, readonly [pc: string, mac: string]> = {
  mod: ["Ctrl", "⌘"],
  ctrl: ["Ctrl", "⌃"],
  alt: ["Alt", "⌥"],
  shift: ["Shift", "⇧"],
  meta: ["Win", "⌘"],
  win: ["Win", "⌘"],
};

/** The order each platform writes modifiers in: Win+Ctrl+Alt+Shift+Z, but ⌃⌥⇧⌘Z. */
const ORDER = { pc: ["Win", "Ctrl", "Alt", "Shift"], mac: ["⌃", "⌥", "⇧", "⌘"] };

/** Keys whose binding name isn't what the key is called. */
const NAMED: Record<string, string> = {
  escape: "Esc",
  esc: "Esc",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Del",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
};

function keyName(key: string, mac: boolean): string {
  const k = key.toLowerCase();
  const modifier = MODIFIERS[k];
  if (modifier) return modifier[mac ? 1 : 0];
  const named = NAMED[k];
  if (named) return named;
  // A letter is printed on its key in capitals; so is F5. Anything else ("insert") starts with one.
  if (k.length === 1 || /^f\d{1,2}$/.test(k)) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

function chordCaps(chord: string, mac: boolean): string[] {
  // A "+" with nothing after it is the plus key itself: "mod++" is Ctrl and +.
  const parts = chord.split(/\+(?=.)/);
  const key = parts.pop()!;
  const order = ORDER[mac ? "mac" : "pc"];
  const held = [...new Set(parts.map((p) => keyName(p, mac)))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  return [...held, keyName(key, mac)];
}

/**
 * A shortcut's key caps: one list per step of a sequence, one cap per key held together.
 * "mod+shift+z" is [["Ctrl", "Shift", "Z"]] (on a Mac [["⇧", "⌘", "Z"]]); "g i" is [["G"], ["I"]].
 */
export function keyCaps(keys: string, mac = IS_MAC): string[][] {
  return keys
    .trim()
    .split(/\s+/)
    .filter((step) => step !== "")
    .map((step) => chordCaps(step, mac));
}

/** A shortcut in words, for a title or a placeholder: "Ctrl+Shift+Z", "⇧⌘Z", "G then I". */
export function keyLabel(keys: string, mac = IS_MAC): string {
  return keyCaps(keys, mac)
    .map((caps) => caps.join(mac ? "" : "+"))
    .join(" then ");
}
