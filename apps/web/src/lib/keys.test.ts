// Shortcuts read as the platform names its keys: Ctrl, Alt and Shift on Windows, ⌘ ⌥ ⇧ on a Mac,
// one cap per key and "then" between the steps of a sequence. Every key the app binds has a name.
import { describe, expect, it } from "vitest";
import { IS_MAC, keyCaps, keyLabel, MOD } from "./keys.ts";

describe("key caps on Windows", () => {
  it("name mod Ctrl, and each held key gets its own cap", () => {
    expect(keyCaps("mod+shift+z", false)).toEqual([["Ctrl", "Shift", "Z"]]);
    expect(keyCaps("alt+w", false)).toEqual([["Alt", "W"]]);
    expect(keyCaps("shift+enter", false)).toEqual([["Shift", "Enter"]]);
  });

  it("put held keys in Windows' order, whatever order the binding names them in", () => {
    expect(keyCaps("shift+alt+mod+k", false)).toEqual([["Ctrl", "Alt", "Shift", "K"]]);
    expect(keyCaps("shift+win+s", false)).toEqual([["Win", "Shift", "S"]]);
  });

  it("split a sequence into its steps", () => {
    expect(keyCaps("g i", false)).toEqual([["G"], ["I"]]);
    expect(keyCaps("  g   i ", false)).toEqual([["G"], ["I"]]);
  });

  it("upper-case a single letter and leave digits and symbols as they are", () => {
    expect(keyCaps("j", false)).toEqual([["J"]]);
    expect(keyCaps("3", false)).toEqual([["3"]]);
    expect(keyCaps("?", false)).toEqual([["?"]]);
    expect(keyCaps("mod+\\", false)).toEqual([["Ctrl", "\\"]]);
    expect(keyCaps("f5", false)).toEqual([["F5"]]);
  });

  it("call keys what they're called, not what the browser calls them", () => {
    expect(keyCaps("escape", false)).toEqual([["Esc"]]);
    expect(keyCaps("arrowup arrowdown arrowleft arrowright", false)).toEqual([
      ["↑"],
      ["↓"],
      ["←"],
      ["→"],
    ]);
    expect(keyCaps("space", false)).toEqual([["Space"]]);
    expect(keyCaps("delete", false)).toEqual([["Del"]]);
    expect(keyCaps("backspace", false)).toEqual([["Backspace"]]);
  });

  it("read a + at the end as the plus key", () => {
    expect(keyCaps("mod++", false)).toEqual([["Ctrl", "+"]]);
    expect(keyCaps("+", false)).toEqual([["+"]]);
  });

  it("make no caps of nothing", () => {
    expect(keyCaps("", false)).toEqual([]);
    expect(keyCaps("   ", false)).toEqual([]);
  });
});

describe("key caps on a Mac", () => {
  it("use the Mac's symbols, in its order: ⌃ ⌥ ⇧ ⌘", () => {
    expect(keyCaps("mod+shift+z", true)).toEqual([["⇧", "⌘", "Z"]]);
    expect(keyCaps("mod+alt+k", true)).toEqual([["⌥", "⌘", "K"]]);
    expect(keyCaps("ctrl+alt+shift+mod+k", true)).toEqual([["⌃", "⌥", "⇧", "⌘", "K"]]);
    expect(keyCaps("alt+w", true)).toEqual([["⌥", "W"]]);
  });

  it("name the other keys as Windows does", () => {
    expect(keyCaps("escape", true)).toEqual([["Esc"]]);
    expect(keyCaps("mod+enter", true)).toEqual([["⌘", "Enter"]]);
    expect(keyCaps("g i", true)).toEqual([["G"], ["I"]]);
  });
});

describe("a shortcut in words", () => {
  it("joins Windows' keys with + and a sequence's steps with then", () => {
    expect(keyLabel("mod+shift+z", false)).toBe("Ctrl+Shift+Z");
    expect(keyLabel("g i", false)).toBe("G then I");
    // Every pane's close button is titled with it (and e2e finds it so).
    expect(keyLabel("alt+w", false)).toBe("Alt+W");
  });

  it("runs a Mac's together, as its menus do", () => {
    expect(keyLabel("mod+shift+z", true)).toBe("⇧⌘Z");
    expect(keyLabel("mod+b", true)).toBe("⌘B");
    expect(keyLabel("g i", true)).toBe("G then I");
  });

  it("calls mod what MOD does on this computer", () => {
    expect(keyCaps("mod")).toEqual([[MOD]]);
    expect(MOD).toBe(IS_MAC ? "⌘" : "Ctrl");
  });
});

const files = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** What a cap may say: a modifier, a named key, F1 to F12, or one printed character. */
const KNOWN = new Set(
  "Ctrl Alt Shift Win Esc Enter Tab Space Backspace Del ↑ ↓ ← → Home End PgUp PgDn".split(" "),
);
const known = (cap: string) => KNOWN.has(cap) || /^F\d{1,2}$/.test(cap) || [...cap].length === 1;

describe("every key the app binds", () => {
  it("has a name, so no cap shows a browser's name for it", () => {
    const bound = Object.values(files).flatMap((text) =>
      // Read as the string it is in the code: "mod+\\" binds the backslash key.
      [...text.matchAll(/\bkeys(?::\s*|=)"([^"]+)"/g)].map(
        (m) => JSON.parse(`"${m[1]}"`) as string,
      ),
    );
    expect(bound.length).toBeGreaterThan(40);
    const unnamed = bound.filter((keys) => !keyCaps(keys, false).flat().every(known));
    expect(unnamed).toEqual([]);
  });
});
