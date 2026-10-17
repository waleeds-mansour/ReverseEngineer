// Nook's look can't slip back: each rule names a class the web app has moved off, and fails on any
// source file that uses it again. Tailwind drops a class it doesn't know without a word, so once a
// scale is gone from the theme (shadow-lg, say) this is what notices. Each rebuild PR adds its
// rule here. A file allowed to keep one is a debt with a date: when it no longer uses the class,
// its entry has to go too, so the list only shrinks.
import { describe, expect, it } from "vitest";
import css from "../index.css?raw";

const files = import.meta.glob<string>(["../**/*.{ts,tsx}", "!../**/*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** A file's code with its comments taken out, since they may name a class to say it's gone. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** The web app's source, by its path under src/ ("components/kit/Card.tsx"). */
const SOURCE = Object.entries(files).map(([path, text]) => [path.slice(3), code(text)] as const);

interface Rule {
  /** What to use instead, as the failure says it. */
  why: string;
  pattern: RegExp;
  /** Files that may still use it, each with what will move it off. */
  allowed?: Record<string, string>;
}

const RULES: Record<string, Rule> = {
  "Tailwind's own shadows": {
    why: "use Nook's depth, shadow-1 to shadow-5 (cards 1, widgets 2, chrome 3, menus 4, focus 5)",
    pattern: /(?<![\w.-])shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl|inner|card|pop))?(?![\w.:-])/,
  },
  "inset and drop shadows": {
    why: "glass and glass-strong carry the lit edge; depth is shadow-1 to shadow-5",
    pattern: /(?<![\w-])(?:inset|drop)-shadow(?![\w(])/,
  },
  "raw layers": {
    why: "use z-(--z-bar), z-(--z-menu), z-(--z-palette), z-(--z-toast) or z-(--z-cover)",
    pattern: /(?<![\w-])z-(?:30|40|50)(?![\w-])|(?<![\w-])z-\[\d+\]/,
  },
  "Tailwind's own durations": {
    why: "use duration-fast, duration-base or duration-slow",
    pattern:
      /(?<![\w-])duration-(?:75|100|150|200|300|500|700|1000|\(--duration-[\w-]+\))(?![\w-])/,
  },
  pulsing: {
    why: "nothing loops but Pip; a skeleton is still, and Pip's own states say it's working",
    pattern: /(?<![\w-])animate-pulse(?![\w-])/,
    allowed: { "components/Mark.tsx": "Pip's mark breathes while it thinks, until B1 draws Pip" },
  },
  spinners: {
    why: "nothing loops but Pip; show Pip thinking, or a still icon and the word",
    pattern: /(?<![\w-])animate-spin(?![\w-])/,
    allowed: {
      "components/ApprovalCard.tsx": "an approval being carried out, until B1",
      "components/kit/Notice.tsx": "a notice's turning icon (Reconnecting…), until B1",
      "shell/TabBar.tsx": "the phone's Pip tab while dictation is written out, until B1",
    },
  },
  "keys spelled by hand": {
    why: 'name a shortcut by its binding, <Kbd keys="mod+k" /> or keyLabel("mod+k") in a title, so it shows one cap per key as this computer names them',
    pattern: /<Kbd(?:\s+hint)?\s*>|\$\{MOD\}|\bMOD\s*===/,
  },
  "badge tones by their older names": {
    why: "use Nook's tones: neutral (no tone), accent, positive, warning or danger (lib/status.ts)",
    pattern: /<Badge\b[^>]*\btone="(?:ok|warn|bad|muted|jarvis)"/,
  },
  "Pill, which Badge replaced": {
    why: "use <Badge> from components/ui.tsx: icon for a chip with one, onRemove for its x, and a status gets its dot",
    pattern: /\bfrom\s+"[^"]*\/kit\/Pill\.tsx"/,
  },
  "a count on a solid fill": {
    why: 'use <Badge count={n} tone="accent" countLabel="…" />: a count is soft accent, hidden at 0, and pops in as it changes',
    pattern:
      /(?<![\w:-])bg-accent(?![\w/-])[^"`]*\btabular-nums\b|\btabular-nums\b[^"`]*(?<![\w:-])bg-accent(?![\w/-])/,
  },
  // Under any variant: focus:outline-none hides the ring as fully as the bare class, now that the
  // ring is in the base layer and no longer beats it.
  "outlines turned off": {
    why: "the focus ring is in the base layer, so this really hides it: keep the ring, or give the element an indicator of its own (focus-visible:ring-2 ring-focus ring-inset) and a reviewed entry here",
    pattern:
      /(?<![\w-])outline-(?:none|hidden|0)(?![\w.-])|\boutline(?:Style|-style)?["']?\s*:\s*["'`]?(?:none|0)(?![\w.%])/,
    allowed: {
      "canvas/Board.tsx": "the board draws an inset ring-focus, so the ring isn't cut by its edge",
      "sheets/Grid.tsx": "a cell editor draws an inset ring-focus inside its cell",
      "views/browser/Screen.tsx": "the live tab view draws an inset ring-focus when it takes keys",
      "components/Menu.tsx":
        "menu rows draw an inset ring-focus, until 1d gives them a solid accent",
      "views/today/AskBar.tsx": "the box around the field draws focus-within:ring-2",
      "shell/CommandPalette.tsx":
        "the launcher's field holds focus the whole time it's open, so the open launcher is its ring",
      "components/DocEditor.tsx":
        "it takes off CodeMirror's dotted box round a note's text, where the caret shows the focus",
    },
  },
};

describe("Nook's look stays", () => {
  for (const [name, rule] of Object.entries(RULES)) {
    it(`with no ${name}`, () => {
      expect(SOURCE.length).toBeGreaterThan(50);
      const found = SOURCE.filter(
        ([path, text]) => rule.pattern.test(text) && !rule.allowed?.[path],
      );
      expect(
        found.map(([path, text]) => `${path}: ${rule.pattern.exec(text)![0]}`),
        rule.why,
      ).toEqual([]);
    });

    if (rule.allowed) {
      it(`keeps no file allowed ${name} that has moved off them`, () => {
        for (const path of Object.keys(rule.allowed!)) {
          const text = SOURCE.find(([p]) => p === path)?.[1];
          expect(text, `${path} is gone; take it off the list`).toBeDefined();
          expect(rule.pattern.test(text!), `${path} no longer needs it`).toBe(true);
        }
      });
    }
  }

  it("with no older depth names in index.css", () => {
    expect(css).not.toMatch(/--shadow-(?:card|pop)\b/);
  });
});
