// Makes src-tauri/src/nook/rules/default.json (docs/nook-wm.md, "PER-APP OVERRIDES"): Nook's own
// entries first, then a translated subset of applications.json from
// LGUG2Z/komorebi-application-specific-configuration (MIT). Only that repository's data is used,
// never komorebi's code. The download is read from the path given, as data, and the commit it
// came from is recorded in the output with the copyright line and license text.
//
//   node scripts/nook-rules.ts <applications.json> <LICENSE> <commit>
//
// What is kept: the ignore, floating and manage lists. What is left out, and why:
// - title-only rules: Nook reads a title only to check a rule that already names the app;
// - rules with a negated condition (DoesNotEqual and the like): Rust's regex has no lookaround,
//   and a rule that half-applies would be worse than none;
// - the behaviour lists (tray_and_multi_window, layered, object_name_change, slow_application,
//   transparency_ignore), which describe how komorebi hides windows, not whether to tile them;
// - manage rules for games and game launchers, which Nook never manages.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Strategy =
  | "Equals"
  | "Legacy"
  | "StartsWith"
  | "EndsWith"
  | "Contains"
  | "Regex"
  | `DoesNot${string}`;
type Id = {
  kind: "Exe" | "Class" | "Title" | "Path";
  id: string;
  matching_strategy: Strategy;
};
type Entry = Id | Id[];
type Match = {
  exe?: string;
  exe_regex?: string;
  class?: string;
  class_regex?: string;
  title_regex?: string;
  path_prefix?: string;
};
type Rule = {
  app: string;
  match: Match;
  action: "manage" | "float" | "ignore";
  flags?: string[];
  from: "nook" | "komorebi-asc";
};

const [source, licensePath, commit] = process.argv.slice(2);
if (!source || !licensePath || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error(
    "usage: node scripts/nook-rules.ts <applications.json> <LICENSE> <commit>",
  );
  process.exit(2);
}

const KINDS: Record<string, Rule["action"]> = {
  ignore: "ignore",
  floating: "float",
  manage: "manage",
};
// Games and game launchers that the list would have managed.
const NEVER_MANAGE = new Set(["Honkai Star Rail", "GOG Galaxy"]);

/** Escapes text for Rust's regex crate, which accepts a backslash before any of these. */
const esc = (s: string) => s.replace(/[\\.+*?()|[\]{}^$#&\-~]/g, "\\$&");

function pattern(id: string, how: Strategy): string | null {
  const e = esc(id);
  switch (how) {
    case "Equals":
      return `^${e}$`;
    case "Legacy":
      return `^${e}|${e}$`;
    case "StartsWith":
      return `^${e}`;
    case "EndsWith":
      return `${e}$`;
    case "Contains":
      return e;
    default:
      return null;
  }
}

/** One AND group as a Nook match, or why it can't be one. */
function translate(group: Id[]): Match | string {
  const m: Match = {};
  const set = <K extends keyof Match>(k: K, v: string) => {
    if (m[k] !== undefined) throw new Error("twice");
    m[k] = v;
  };
  try {
    for (const { kind, id, matching_strategy: how } of group) {
      if (how.startsWith("DoesNot")) return "negated";
      if (kind === "Exe") {
        if (how === "Equals" || how === "Legacy") set("exe", id);
        else {
          const p = pattern(id, how);
          if (!p) return `exe ${how}`;
          set("exe_regex", `(?i)${p}`);
        }
      } else if (kind === "Class") {
        if (how === "Equals") set("class", id);
        else {
          const p = pattern(id, how);
          if (!p) return `class ${how}`;
          set("class_regex", `(?i)${p}`);
        }
      } else if (kind === "Title") {
        const p = pattern(id, how);
        if (!p) return `title ${how}`;
        set("title_regex", p);
      } else if (kind === "Path" && how === "StartsWith") {
        set("path_prefix", id);
      } else {
        return `${kind} ${how}`;
      }
    }
  } catch {
    return "a condition twice";
  }
  if (Object.keys(m).every((k) => k === "title_regex")) return "title only";
  return m;
}

const own = (
  app: string,
  match: Match,
  action: Rule["action"],
  flags?: string[],
): Rule => ({
  app,
  match,
  action,
  ...(flags ? { flags } : {}),
  from: "nook",
});
const sticky = ["no_hide"];
const rules: Rule[] = [
  own("Dialogs", { class: "#32770" }, "float"),
  own("Task Manager", { exe: "Taskmgr.exe" }, "float"),
  own("Calculator", { exe: "CalculatorApp.exe" }, "float"),
  own("Snipping Tool", { exe: "SnippingTool.exe" }, "ignore"),
  own("Snipping Tool", { exe: "ScreenClippingHost.exe" }, "ignore"),
  own("Steam", { exe: "steam.exe" }, "float", sticky),
  own("Steam", { exe: "steamwebhelper.exe" }, "float", sticky),
  own("Epic Games Launcher", { exe: "EpicGamesLauncher.exe" }, "float", sticky),
  own("EA app", { exe: "EADesktop.exe" }, "float", sticky),
  own("Overwolf", { exe: "Overwolf.exe" }, "float", sticky),
  own("Wallpaper Engine", { exe: "ui32.exe" }, "float"),
  own("Discord", { exe: "Discord.exe" }, "float", sticky),
  own("Spotify", { exe: "Spotify.exe" }, "float", sticky),
  own("Docker Desktop", { exe: "Docker Desktop.exe" }, "float", sticky),
];

const data = JSON.parse(readFileSync(source, "utf8")) as Record<
  string,
  Record<string, Entry[]>
>;
const skipped: Record<string, number> = {};
const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
let kept = 0;
for (const [app, lists] of Object.entries(data)) {
  if (app.startsWith("$")) continue;
  // Per app: manage before floating before ignore, so the narrower rule wins as it did upstream.
  for (const kind of ["manage", "floating", "ignore"]) {
    for (const entry of lists[kind] ?? []) {
      if (kind === "manage" && NEVER_MANAGE.has(app)) {
        skip("a game or launcher to manage");
        continue;
      }
      const m = translate(Array.isArray(entry) ? entry : [entry]);
      if (typeof m === "string") {
        skip(m);
        continue;
      }
      rules.push({ app, match: m, action: KINDS[kind], from: "komorebi-asc" });
      kept += 1;
    }
  }
  for (const kind of Object.keys(lists)) {
    if (!(kind in KINDS)) skip(`behaviour list ${kind}`);
  }
}

const license = readFileSync(licensePath, "utf8").replace(/\r\n/g, "\n").trim();
const copyright = license.split("\n").find((l) => l.startsWith("Copyright"));
if (!copyright) throw new Error("the license has no copyright line");
const out = {
  source: {
    repository:
      "https://github.com/LGUG2Z/komorebi-application-specific-configuration",
    file: "applications.json",
    commit,
    license: "MIT",
    copyright,
    license_text: license,
    translated_by: "apps/desktop/scripts/nook-rules.ts",
    kept,
    skipped,
  },
  rules,
};
// One rule per line keeps the file readable and its diffs small.
const body = rules.map((r) => `    ${JSON.stringify(r)}`).join(",\n");
const head = JSON.stringify(out.source, null, 2).replace(/\n/g, "\n  ");
const text = `{\n  "source": ${head},\n  "rules": [\n${body}\n  ]\n}\n`;
JSON.parse(text);
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "src",
  "nook",
  "rules",
  "default.json",
);
writeFileSync(target, text);
console.log(
  `${rules.length} rules (${kept} from komorebi-asc), skipped ${JSON.stringify(skipped)}`,
);
