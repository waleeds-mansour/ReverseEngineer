// Writes the theme stylesheets from Nook's design-system tokens:
//   node scripts/nook-themes.ts          rewrite apps/web/src/styles/{nook.css,themes/*.css} and
//                                        the desktop app's apps/desktop/src/nook/nook.css
//   node scripts/nook-themes.ts --check  exit 1 if any of them is out of date
// design/nook/tokens.json is the one source of values; the desktop's sheet also takes the
// components it draws from design/nook/components/bundle.css. lib/tokens.test.ts and
// lib/nookChrome.test.ts make the same check.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ChromeTokens,
  NOOK_CHROME_CSS,
  renderNookChrome,
} from "../apps/web/src/lib/nookChrome.ts";
import { renderNook } from "../apps/web/src/lib/nookTokens.ts";

const root = join(import.meta.dirname, "..");
const tokens = JSON.parse(
  readFileSync(join(root, "design/nook/tokens.json"), "utf8"),
) as ChromeTokens;
const bundle = readFileSync(join(root, "design/nook/components/bundle.css"), "utf8");
const check = process.argv.includes("--check");
const stale: string[] = [];

const outputs: Record<string, string> = {
  [NOOK_CHROME_CSS]: renderNookChrome(tokens, bundle),
};
for (const [path, text] of Object.entries(renderNook(tokens))) {
  outputs[`apps/web/src/styles/${path}`] = text;
}

for (const [path, text] of Object.entries(outputs)) {
  const file = join(root, path);
  let now = "";
  try {
    now = readFileSync(file, "utf8");
  } catch {}
  if (now === text) continue;
  if (check) stale.push(path);
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    console.log(`wrote ${path}`);
  }
}

if (stale.length) {
  console.error(`Out of date: ${stale.join(", ")}. Run node scripts/nook-themes.ts.`);
  process.exit(1);
}
