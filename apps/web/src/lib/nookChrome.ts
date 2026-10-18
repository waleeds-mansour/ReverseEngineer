// Nook's own stylesheet in the desktop app (apps/desktop/src/nook/nook.css), for the bar, its
// popover and the panel: every token of design/nook/tokens.json under the names the design
// system's components use (--ink, --space-3, --dur-base), light at :root and the other five
// themes under data-theme, then the components those pages draw, taken from
// design/nook/components/bundle.css with two changes docs/nook-wm.md asks for: no CSS
// backdrop-filter (DWM's acrylic is the only blur) and no idle animation on Pip (the idle bar
// presents no frames). scripts/nook-themes.ts writes it; nookChrome.test.ts checks it's current.

import { DARK_THEMES, type NookTokens, over } from "./nookTokens.ts";

/** Where the stylesheet goes, from the repository's root. */
export const NOOK_CHROME_CSS = "apps/desktop/src/nook/nook.css";

/** The rules of bundle.css the chrome uses, by how their selector starts. */
const KEEP = [
  ".re-glass",
  ".re-caption",
  ".re-overline",
  ":focus-visible",
  ".re-btn",
  ".re-switch",
  ".re-seg",
  ".re-badge",
  ".re-kbd",
  ".re-bar",
  ".re-ws",
  ".re-menu",
  ".re-item",
  ".re-sep",
  ".re-group",
  ".re-popover",
  ".re-toast",
  ".re-island",
  ".pip",
  "@keyframes pip-",
];
/** Pip asleep is for quiet hours, which the bar doesn't show yet. */
const DROP = ["pip--asleep", "pip-snooze", "pip-z{", "pip-z "];
/** Pip's idle pose moves forever in the design system; in the bar it holds still. */
const IDLE = [".pip .pip-body", ".pip .pip-glow", ".pip .pip-eyes"];

const HEADER =
  "/* Nook's chrome in the desktop app: generated from design/nook/tokens.json and\n" +
  "   design/nook/components/bundle.css by scripts/nook-themes.ts. Don't edit by hand; change\n" +
  "   those and run `node scripts/nook-themes.ts`. */\n";

/** How much of a status colour tints its soft background, as the web's nook.css mixes it. */
const SOFT = 0.14;

/** tokens.json as the chrome reads it: the web's view of it, with the font families and spacing. */
export type ChromeTokens = NookTokens & {
  type: { families: Record<string, string> };
  spacing: { tokens: { name: string; value: string }[] };
};

type Value = string | Record<string, string>;
const pick = (v: Value, theme: string, first: string) =>
  typeof v === "string" ? v : (v[theme] ?? v[first]!);

/** Every colour and shadow of one theme, as `--name: value`. */
function themed(tokens: ChromeTokens, theme: string): [string, string][] {
  const first = tokens.color.themes[0]!.id;
  const raw = (name: string): string => {
    const t = tokens.color.tokens.find((c) => c.name === name);
    if (!t) throw new Error(`tokens.json has no colour ${name}`);
    const v = pick(t.value, theme, first);
    const alias = /^\{([\w.-]+)\}$/.exec(v);
    return alias ? raw(alias[1]!) : v;
  };
  const out: [string, string][] = tokens.color.tokens.map((t) => {
    const v = pick(t.value, theme, first);
    const alias = /^\{([\w.-]+)\}$/.exec(v);
    return [`--${t.name}`, alias ? `var(--${alias[1]})` : v];
  });
  const surface = raw("surface-1");
  for (const [name, status] of [
    ["ok-soft", "positive"],
    ["warn-soft", "warning"],
    ["bad-soft", "danger"],
  ] as const) {
    out.push([`--${name}`, over(raw(status), surface, SOFT)]);
  }
  for (const t of tokens.shadow.tokens) out.push([`--${t.name}`, pick(t.value, theme, first)]);
  return out;
}

/** The tokens that are the same in every theme. */
function fixed(tokens: ChromeTokens): [string, string][] {
  const out: [string, string][] = Object.entries(tokens.type.families).map(([name, family]) => [
    `--font-${name}`,
    family,
  ]);
  const groups = [tokens.spacing, tokens.radius, tokens.size, tokens.blur, tokens.timing];
  for (const t of [...groups, tokens.zIndex].flatMap((g) => g.tokens)) {
    out.push([`--${t.name}`, t.value]);
  }
  return out;
}

/** Declarations packed onto lines of at most 100 columns. */
function packed(decls: [string, string][]): string[] {
  const lines: string[] = [];
  let line = "";
  for (const [k, v] of decls) {
    const d = `${k}: ${v};`;
    if (line && line.length + 1 + d.length > 98) {
      lines.push(`  ${line}`);
      line = d;
    } else line = line ? `${line} ${d}` : d;
  }
  if (line) lines.push(`  ${line}`);
  return lines;
}

/** bundle.css's top-level rules, one string each. */
export function rules(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) {
      out.push(text.slice(start, i + 1).trim());
      start = i + 1;
    }
  }
  return out.filter(Boolean);
}

/** The rules the chrome draws with, changed as the header says. */
function components(bundle: string): string[] {
  return rules(bundle)
    .filter((r) => KEEP.some((k) => r.startsWith(k)) && !DROP.some((d) => r.includes(d)))
    .map((r) => r.replace(/(-webkit-)?backdrop-filter:[^;}]*;?/g, ""))
    .map((r) =>
      IDLE.some((s) => r.startsWith(`${s}{`)) ? r.replace(/animation:[^;}]*;?/g, "") : r,
    )
    .map((r) => r.replace(/;}/g, "}"));
}

const MOTION = [
  "/* A theme change crossfades over dur-base; nothing moves when Windows or the page asks for less",
  "   motion (Rust forwards Windows' animation setting as data-reduced). */",
  ":root[data-theme-fade] *, :root[data-theme-fade] *::before, :root[data-theme-fade] *::after {",
  "  transition: background-color var(--dur-base) var(--ease-standard),",
  "    border-color var(--dur-base) var(--ease-standard), color var(--dur-base) var(--ease-standard),",
  "    fill var(--dur-base) var(--ease-standard), box-shadow var(--dur-base) var(--ease-standard);",
  "}",
  "@media (prefers-reduced-motion: reduce) {",
  "  *, *::before, *::after { animation: none !important; transition: none !important; }",
  "}",
  ":root[data-reduced] *, :root[data-reduced] *::before, :root[data-reduced] *::after {",
  "  animation: none !important; transition: none !important;",
  "}",
];

export function renderNookChrome(tokens: ChromeTokens, bundle: string): string {
  const first = tokens.color.themes[0]!.id;
  const light = themed(tokens, first);
  const root = [
    ":root {",
    "  color-scheme: light;",
    ...[...light, ...fixed(tokens)].map(([k, v]) => `  ${k}: ${v};`),
    "}",
  ];
  const themes: string[] = [];
  for (const { id } of tokens.color.themes.slice(1)) {
    const base = new Map(light);
    const diff = themed(tokens, id).filter(([k, v]) => base.get(k) !== v);
    themes.push(
      `:root[data-theme="${id}"] {`,
      `  color-scheme: ${DARK_THEMES.has(id) ? "dark" : "light"};`,
      ...packed(diff),
      "}",
    );
  }
  return `${[
    HEADER.trimEnd(),
    ...root,
    ...themes,
    "/* From the design system's components. */",
    ...components(bundle),
    ...MOTION,
  ].join("\n")}\n`;
}
