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

/**
 * A file's code with its comments taken out, since they may name a class to say it's gone. A //
 * after a colon is a URL's ("https://…"), not a comment.
 */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** The web app's source, by its path under src/ ("components/kit/Card.tsx"). */
const SOURCE = Object.entries(files).map(([path, text]) => [path.slice(3), code(text)] as const);

/**
 * Each opening <Tag …> in a file's code, to the > that closes it. Braces are skipped whole, so an
 * arrow's => in an onClick doesn't end the tag, and nor does a > in a quoted attribute.
 */
function openingTags(text: string, tag: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(new RegExp(`<${tag}(?![\\w.])`, "g"))) {
    let depth = 0;
    let quote = "";
    let i = m.index + m[0].length;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === "`" || (depth === 0 && (c === '"' || c === "'"))) quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    found.push(text.slice(m.index, i + 1));
  }
  return found;
}

interface Rule {
  /** What to use instead, as the failure says it. */
  why: string;
  pattern: RegExp;
  /** Tested against each opening tag of this component, rather than the whole file. */
  tag?: string;
  /** Files that may still use it, each with what will move it off. */
  allowed?: Record<string, string>;
}

/**
 * A tag with what its props hold taken out, quotes and braces both, so a tag rule tests the props'
 * names: a title that says "the kind of reply" isn't a kind= prop.
 */
function propNames(tag: string): string {
  let out = "";
  let depth = 0;
  let quote = "";
  for (const c of tag) {
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === "`" || (depth === 0 && (c === '"' || c === "'"))) quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

/** Where a file breaks a rule: the first match, or the first tag that matches. */
function hit(rule: Rule, text: string): string | undefined {
  if (!rule.tag) return rule.pattern.exec(text)?.[0];
  return openingTags(text, rule.tag)
    .find((t) => rule.pattern.test(propNames(t)))
    ?.replace(/\s+/g, " ");
}

/**
 * Raw <button>s in the web app's source. One that is a Button, IconButton or TextButton in all but
 * name moves to the kit; the rest (rows, tiles, tabs, editor controls) move in Phase 4's view
 * passes. The count only goes down: when a change takes one away, it lowers this to match.
 */
const RAW_BUTTONS = 62;

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
  "Button's older props": {
    why: 'use variant= ("primary", "quiet"; secondary is the default), size="sm" and type="submit"; a one-click Disconnect or Remove is tone="danger" until 1e asks first in an Alert',
    tag: "Button",
    pattern: /\s(?:kind|small|submit)(?=[\s=/>])/,
  },
  "IconButton's icon size": {
    why: "the icon follows the button's size (16 px in a 28 px square), so leave size off",
    tag: "IconButton",
    pattern: /\ssize=/,
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
      const found = SOURCE.flatMap(([path, text]) => {
        const at = rule.allowed?.[path] ? undefined : hit(rule, text);
        return at === undefined ? [] : [`${path}: ${at}`];
      });
      expect(found, rule.why).toEqual([]);
    });

    if (rule.allowed) {
      it(`keeps no file allowed ${name} that has moved off them`, () => {
        for (const path of Object.keys(rule.allowed!)) {
          const text = SOURCE.find(([p]) => p === path)?.[1];
          expect(text, `${path} is gone; take it off the list`).toBeDefined();
          expect(hit(rule, text!), `${path} no longer needs it`).toBeDefined();
        }
      });
    }
  }

  it("with no older depth names in index.css", () => {
    expect(css).not.toMatch(/--shadow-(?:card|pop)\b/);
  });

  it("with no more raw <button>s than before", () => {
    const count = SOURCE.reduce((n, [, text]) => n + (text.match(/<button\b/g)?.length ?? 0), 0);
    expect(
      count,
      "use Button, IconButton or TextButton from components/ui.tsx",
    ).toBeLessThanOrEqual(RAW_BUTTONS);
    expect(count, `${count} now: lower RAW_BUTTONS to it, so they can't come back`).toBe(
      RAW_BUTTONS,
    );
  });

  it("finds a tag whatever its props hold", () => {
    const [tag] = openingTags(
      `<Button onClick={() => go(a > b)} title="x > y" size="sm">Go</Button>`,
      "Button",
    );
    expect(tag).toBe(`<Button onClick={() => go(a > b)} title="x > y" size="sm">`);
    expect(openingTags("<ButtonGroup><Button.Icon />", "Button")).toEqual([]);
  });

  it("tests a tag's prop names, not the words they hold", () => {
    const old = RULES["Button's older props"]!;
    const titled = `<Button title="Pick the kind of reply" onClick={() => go(small)}>`;
    expect(hit(old, titled)).toBeUndefined();
    expect(hit(old, code(`<Button href="https://example.com" small>Go</Button>`))).toBeDefined();
    const size = RULES["IconButton's icon size"]!;
    expect(
      hit(size, code(`<IconButton title="https://x.y" />\n<Button size="sm">`)),
    ).toBeUndefined();
  });
});
