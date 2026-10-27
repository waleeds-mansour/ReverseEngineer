// A repo's history for Pip: its commits, a commit's or a range's changes, and who last changed
// each line of a file. All of it only reads; what comes back is capped, and diffs leave out files
// that may hold secrets. Commit messages and code are other people's words as often as yours, so
// what Pip reads here counts as outside content (D25).
import { ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { emptyTree, resolveRef, runGit, short } from "./git.ts";
import { cleanPath, isSecret, literal, SECRET_WORDS, secretSpecs } from "./paths.ts";
import { openRepo } from "./repos.ts";

export const repoField = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .describe("The repo's name or folder, as code_repos lists it.");
export const refField = z.string().trim().min(1).max(200);
const pathField = z.string().trim().max(500);

/** The most of a diff Pip gets back, in characters. */
export const DIFF_CHARS = 60_000;
/** The most files a diff lists. */
const DIFF_FILES = 300;
/** The most lines one blame covers. */
export const BLAME_LINES = 200;
/** A line of code longer than this is cut. */
export const LINE_CHARS = 500;

const SEP = "\x1f";
const END = "\x1e";

export interface Commit {
  sha: string;
  at: string;
  author: string;
  subject: string;
}

/** Commits from one back, newest first, optionally only those touching a path. */
export async function commits(
  repo: string,
  sha: string,
  opts: { path?: string; limit: number; body?: boolean },
): Promise<{ commits: (Commit & { body?: string })[]; more: boolean }> {
  const format = ["%H", "%aI", "%an", "%s", ...(opts.body ? ["%b"] : [])].join(SEP);
  const args = ["log", `--max-count=${opts.limit + 1}`, `--format=${format}${END}`, sha];
  const out = await runGit(repo, opts.path ? [...args, "--", literal(opts.path)] : args);
  const rows = out.text
    .split(END)
    .map((r) => r.replace(/^\r?\n/, ""))
    .filter((r) => r.includes(SEP))
    .map((r) => {
      const [full = "", at = "", author = "", subject = "", body] = r.split(SEP);
      const c: Commit & { body?: string } = { sha: short(full), at, author, subject };
      if (opts.body && body?.trim()) c.body = body.trim().slice(0, 4000);
      return c;
    });
  return { commits: rows.slice(0, opts.limit), more: rows.length > opts.limit || out.truncated };
}

interface FileChange {
  status: string;
  path: string;
  from?: string;
}

/** What changed between two trees, file by file (-z, so any name parses). */
async function changedFiles(repo: string, a: string, b: string, spec: string[]) {
  const out = await runGit(repo, ["diff", "--name-status", "-z", "-M", a, b, "--", ...spec]);
  const t = out.text.split("\0");
  const files: FileChange[] = [];
  for (let i = 0; i + 1 < t.length; ) {
    const status = t[i]!.trim();
    if (!status) {
      i++;
      continue;
    }
    if (/^[RC]/.test(status)) {
      files.push({ status: status[0]!, from: t[i + 1]!, path: t[i + 2] ?? "" });
      i += 3;
    } else {
      files.push({ status, path: t[i + 1]! });
      i += 2;
    }
  }
  return { files, truncated: out.truncated };
}

/** A diff between two trees, with files that may hold secrets named but not shown. */
async function diffBetween(repo: string, a: string, b: string, path: string) {
  const spec = path ? [literal(path)] : [];
  const listed = await changedFiles(repo, a, b, spec);
  const hidden = listed.files
    .flatMap((f) => [f.path, f.from ?? ""])
    .filter((p) => p && isSecret(p));
  const out = await runGit(
    repo,
    [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "-M",
      a,
      b,
      "--",
      ...spec,
      ...secretSpecs(),
    ],
    { maxBytes: DIFF_CHARS * 4 },
  );
  const cut = out.text.length > DIFF_CHARS;
  return {
    files: listed.files.slice(0, DIFF_FILES),
    hidden: [...new Set(hidden)],
    diff: cut ? `${out.text.slice(0, DIFF_CHARS)}\n… (cut here)` : out.text,
    truncated: cut || out.truncated || listed.truncated || listed.files.length > DIFF_FILES,
  };
}

export const historyActions = [
  defineAction({
    name: "code.log",
    description:
      "A repo's recent commits, newest first: id, date, author and subject. From a branch, tag or commit (HEAD unless you say), and only those that touched a file or folder if you give a path. At most 100. Reads only, without asking; commit messages count as outside content.",
    input: z.object({
      repo: repoField,
      ref: refField.optional().describe("Branch, tag or commit to start from. HEAD if left out."),
      path: pathField.optional().describe("Only commits that touched this file or folder."),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    risk: "read",
    callers: ["owner", "agent"],
    external: true,
    io: true,
    async handler(i, ctx) {
      const repo = await openRepo(ctx.tx, i.repo);
      const sha = await resolveRef(repo.path, i.ref ?? "HEAD");
      const path = cleanPath(i.path);
      const got = await commits(repo.path, sha, { path, limit: i.limit });
      return { repo: repo.name, ref: i.ref ?? "HEAD", ...got, outside: true };
    },
  }),
  defineAction({
    name: "code.diff",
    description: `What changed in a repo: one commit's own changes (give commit), or everything between two refs (give from, and to, which is HEAD if left out). Optionally only under a path. Lists the files, then the diff, cut at ${DIFF_CHARS} characters. Files that may hold secrets (.env, keys, credentials) are named under hidden but not shown. Reads only, without asking; the code counts as outside content.`,
    input: z.object({
      repo: repoField,
      commit: refField.optional().describe("A commit to show its own changes, against its parent."),
      from: refField.optional().describe("The older side of a comparison."),
      to: refField.optional().describe("The newer side. HEAD if left out."),
      path: pathField.optional().describe("Only changes under this file or folder."),
    }),
    risk: "read",
    callers: ["owner", "agent"],
    external: true,
    io: true,
    async handler(i, ctx) {
      const repo = await openRepo(ctx.tx, i.repo);
      const path = cleanPath(i.path);
      if (i.commit) {
        const sha = await resolveRef(repo.path, i.commit);
        const parent = await runGit(repo.path, ["rev-parse", "--verify", "--quiet", `${sha}^1`], {
          ok: [1, 128],
        });
        const base = parent.code === 0 ? parent.text.trim() : emptyTree(sha);
        const [about] = (await commits(repo.path, sha, { limit: 1, body: true })).commits;
        const d = await diffBetween(repo.path, base, sha, path);
        return { repo: repo.name, commit: about, ...d, outside: true };
      }
      if (!i.from)
        throw new ActionError(
          "invalid_input",
          "Give a commit to see its changes, or from (and to) to compare two refs.",
        );
      const a = await resolveRef(repo.path, i.from);
      const b = await resolveRef(repo.path, i.to ?? "HEAD");
      const d = await diffBetween(repo.path, a, b, path);
      return { repo: repo.name, from: i.from, to: i.to ?? "HEAD", ...d, outside: true };
    },
  }),
  defineAction({
    name: "code.blame",
    description: `Who last changed each line of a file in a repo, and in which commit: lines start to end (at most ${BLAME_LINES}), as of HEAD or a ref you give. Each line comes with its commit id, author and date; the commits' subjects come once each. Not for files that may hold secrets. Reads only, without asking; the code counts as outside content.`,
    input: z.object({
      repo: repoField,
      path: pathField.min(1).describe("The file, from the repo's top folder, like src/app.ts."),
      start: z.number().int().min(1).default(1),
      end: z.number().int().min(1).optional().describe(`Last line. ${BLAME_LINES} lines at most.`),
      ref: refField.optional().describe("Branch, tag or commit. HEAD if left out."),
    }),
    risk: "read",
    callers: ["owner", "agent"],
    external: true,
    io: true,
    async handler(i, ctx) {
      const repo = await openRepo(ctx.tx, i.repo);
      const path = cleanPath(i.path);
      if (!path) throw new ActionError("invalid_input", "Name a file to blame.");
      if (isSecret(path)) throw new ActionError("forbidden", SECRET_WORDS);
      const sha = await resolveRef(repo.path, i.ref ?? "HEAD");
      const end = Math.min(i.end ?? i.start + 49, i.start + BLAME_LINES - 1);
      if (end < i.start) throw new ActionError("invalid_input", "end comes before start.");
      const out = await runGit(repo.path, [
        "blame",
        "--porcelain",
        "--no-textconv",
        // A repo's config can name a file of commits to skip; git would read it, and quote it back.
        "--no-ignore-revs-file",
        `-L${i.start},${end}`,
        sha,
        "--",
        path,
      ]);
      return { repo: repo.name, path, ref: i.ref ?? "HEAD", ...readBlame(out.text), outside: true };
    },
  }),
];

/** git blame --porcelain: each commit's details once, then a line of code after a tab. */
export function readBlame(text: string) {
  const subjects: Record<string, string> = {};
  const info = new Map<string, { author: string; at: string }>();
  const lines: { line: number; sha: string; author: string; at: string; text: string }[] = [];
  let sha = "";
  let line = 0;
  for (const row of text.split("\n")) {
    if (row.startsWith("\t")) {
      const who = info.get(sha) ?? { author: "", at: "" };
      lines.push({ line, sha: short(sha), ...who, text: row.slice(1, 1 + LINE_CHARS) });
      continue;
    }
    const head = /^([0-9a-f]{40,64}) \d+ (\d+)/.exec(row);
    if (head) {
      sha = head[1]!;
      line = Number(head[2]);
      if (!info.has(sha)) info.set(sha, { author: "", at: "" });
      continue;
    }
    const space = row.indexOf(" ");
    const key = row.slice(0, space);
    const value = row.slice(space + 1).trim();
    const who = info.get(sha);
    if (!who) continue;
    if (key === "author") who.author = value;
    else if (key === "author-time") who.at = new Date(Number(value) * 1000).toISOString();
    else if (key === "summary") subjects[short(sha)] = value;
  }
  return { lines, subjects };
}
