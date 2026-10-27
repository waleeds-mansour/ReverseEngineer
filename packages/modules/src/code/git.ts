// Git, run for Pip's reading of a repo you added (Spec 2). Always git's own program, found once on
// PATH, never a git.exe a repo keeps in its folder; always a list of arguments, never a shell;
// always a time limit, a cap on what comes back, and a few at a time. A repo's own config can name
// programs for git to run while it reads (core.fsmonitor, an external diff, textconv, a signature
// check, a fetch for a partial clone's missing objects) or files for it to read (a mailmap, a list
// of commits blame skips); settings given on the command line win over the repo's, so each is
// turned off here, and diffs and blame pass --no-ext-diff and --no-textconv. Git also never looks
// past the repo's own folder for a .git, and never takes a lock or writes its index while it reads.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { ActionError } from "@hearth/kernel";
import { cleanRef } from "./paths.ts";
import { Slots } from "./slots.ts";

/** How long one git command may take. */
export const GIT_TIMEOUT_MS = 15_000;
/** The most one git command's output is read; past it, git is stopped and what came is used. */
export const GIT_MAX_BYTES = 1024 * 1024;

const WINDOWS = process.platform === "win32";

/** Turned off on every call, whatever the repo's config says. */
const SAFE_CONFIG = [
  // Empty rather than false: git before 2.36 took the value as a program's path.
  "core.fsmonitor=",
  "log.showSignature=false",
  "protocol.allow=never",
  "protocol.file.allow=never",
  "protocol.ext.allow=never",
  "submodule.recurse=false",
  "grep.fallbackToNoIndex=false",
  "gc.auto=0",
  "maintenance.auto=false",
  "core.quotePath=false",
  "color.ui=false",
  // Files a repo's config could point anywhere on this PC. (An empty orderFile is an error.)
  "mailmap.file=",
  "mailmap.blob=",
  "diff.orderFile=/dev/null",
];

const MISSING = "Git isn't installed on this PC, or Nook can't find it.";

/** Where git's program is, from PATH's folders only. Null if there's none. */
export function findGit(env: NodeJS.ProcessEnv = process.env, windows = WINDOWS): string | null {
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  for (const raw of (key ? (env[key] ?? "") : "").split(delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    // A folder named from wherever git starts (".", or none) could be a repo's: never searched.
    if (!dir || !isAbsolute(dir)) continue;
    const file = join(dir, windows ? "git.exe" : "git");
    if (!isFile(file)) continue;
    if (!windows) return file;
    // Git for Windows' cmd\git.exe and bin\git.exe start the real git and wait. Run the real one,
    // so stopping it stops git itself.
    const root = ["cmd", "bin"].includes(basename(dir).toLowerCase()) ? dirname(dir) : null;
    const real = root
      ? ["mingw64", "clangarm64", "mingw32"]
          .map((d) => join(root, d, "bin", "git.exe"))
          .find(isFile)
      : undefined;
    return real ?? file;
  }
  return null;
}

function isFile(path: string) {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

let found: string | null = null;

/** Git's program, found once it's there. */
export function gitPath(): string {
  found ??= findGit();
  if (!found) throw new ActionError("unavailable", MISSING);
  return found;
}

/** The environment without anything of git's that Nook's own process had, plus the guards. */
function gitEnv(repo: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: dirname(repo),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    // Nor does git, on Windows, start a program of its own from the folder it's working in.
    NoDefaultCurrentDirectoryInExePath: "1",
  };
}

export interface GitOut {
  text: string;
  /** Git said more than the cap, and was stopped. */
  truncated: boolean;
  /** Its exit code: 0, or one the caller said is fine (git grep's 1 for no matches). */
  code: number;
}

/**
 * What git's errors mean, in fixed words. Git's own message can quote a file it read (a config
 * line, a list of commits), so it's never passed on.
 */
const KNOWN: [RegExp, ActionError["code"], (m: RegExpExecArray) => string][] = [
  [/dubious ownership/i, "failed", () => "Git won't open this repo for Nook's account."],
  [/not a git repository/i, "failed", () => "This folder isn't a git repo any more."],
  [/does not have any commits yet/i, "not_found", () => "This repo has no commits yet."],
  [/has only (\d+) lines?/i, "invalid_input", (m) => `That file has only ${m[1]} lines.`],
  [
    /no such path|does not exist in|exists on disk, but not in|did not match any file/i,
    "not_found",
    () => "There's no such file there.",
  ],
  [
    /unknown revision|bad revision|bad object|invalid object name|not a valid object name/i,
    "not_found",
    () => "Git couldn't find that commit.",
  ],
];

function gitError(stderr: string, code: number) {
  for (const [re, kind, words] of KNOWN) {
    const m = re.exec(stderr);
    if (m) return new ActionError(kind, words(m));
  }
  return new ActionError("failed", `Git couldn't do that (exit ${code}).`);
}

/** Stops git and anything it started: Node's own kill reaches only the program it started. */
export function stopTree(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const kill = () => child.kill("SIGKILL");
  if (!WINDOWS || !child.pid) return kill();
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  const args = ["/T", "/F", "/PID", String(child.pid)];
  execFile(taskkill, args, { windowsHide: true, timeout: 5000 }, kill);
}

/** At most 4 gits at once, 2 in any one repo; more calls wait, briefly. */
export const slots = new Slots(4, 2, 32, GIT_TIMEOUT_MS);

/**
 * Runs git in a repo you added. `ok` lists exit codes that aren't failures. Any other failure is
 * an ActionError in fixed words.
 */
export async function runGit(
  repo: string,
  args: string[],
  opts: { ok?: number[]; maxBytes?: number } = {},
): Promise<GitOut> {
  const git = gitPath();
  const done = await slots.take(WINDOWS ? repo.toLowerCase() : repo);
  try {
    return await run(git, repo, args, opts);
  } finally {
    done();
  }
}

function run(
  git: string,
  repo: string,
  args: string[],
  opts: { ok?: number[]; maxBytes?: number },
): Promise<GitOut> {
  const argv = [
    "-C",
    repo,
    "--no-pager",
    ...SAFE_CONFIG.flatMap((c) => ["-c", c]),
    // Nook's server runs as its own Windows account, which git won't read your repos as unless
    // told. You added this exact folder, and git looks nowhere above it (GIT_CEILING_DIRECTORIES).
    "-c",
    `safe.directory=${repo.replaceAll("\\", "/")}`,
    // A repo's config can point its work tree at another folder; it's always this one.
    `--work-tree=${repo}`,
    ...args,
  ];
  const max = opts.maxBytes ?? GIT_MAX_BYTES;
  return new Promise((resolve, reject) => {
    // Started from a folder that isn't the repo's, so nothing in the repo is ever run.
    const child = spawn(git, argv, {
      cwd: tmpdir(),
      env: gitEnv(repo),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let late = false;
    let stderr = "";
    const timer = setTimeout(() => {
      late = true;
      stopTree(child);
    }, GIT_TIMEOUT_MS);
    child.stdout.on("data", (b: Buffer) => {
      if (truncated) return;
      if (size + b.length <= max) {
        out.push(b);
        size += b.length;
        return;
      }
      out.push(b.subarray(0, max - size));
      truncated = true;
      stopTree(child);
    });
    child.stderr.on("data", (b: Buffer) => {
      if (stderr.length < 8192) stderr += b.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new ActionError(err.code === "ENOENT" ? "unavailable" : "failed", MISSING));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8");
      if (truncated) return resolve({ text, truncated: true, code: 0 });
      if (late)
        return reject(
          new ActionError(
            "unavailable",
            `Git took over ${GIT_TIMEOUT_MS / 1000} seconds, so Nook stopped it. Ask for less: a path, a smaller range.`,
          ),
        );
      const c = code ?? 1;
      if (c === 0 || opts.ok?.includes(c)) return resolve({ text, truncated: false, code: c });
      reject(gitError(stderr, c));
    });
  });
}

/** Resolves a ref Pip named to its commit's id, so only an id ever reaches git after this. */
export async function resolveRef(repo: string, raw: string): Promise<string> {
  const ref = cleanRef(raw);
  const out = await runGit(
    repo,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { ok: [1, 128] },
  );
  const sha = out.text.trim();
  if (out.code !== 0 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha))
    throw new ActionError("not_found", `There's no commit "${ref}" in this repo.`);
  return sha;
}

/** A commit id short enough to read and still unique in any repo Pip would read. */
export const short = (sha: string) => sha.slice(0, 12);

/** The empty tree, to diff a repo's first commit against: its id depends on the repo's hash. */
export const emptyTree = (sha: string) =>
  sha.length === 64
    ? "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
    : "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
