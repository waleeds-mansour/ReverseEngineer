// A repo's files for Pip: which repos it can read, a search over the files git tracks, and a
// file's lines or a folder's contents, from the working tree or as of a commit. From the working
// tree Pip reads only what git tracks or would add: what .gitignore leaves out (built files,
// local settings, often secrets) stays out, and so does any file that may hold secrets.
import { open, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { ActionError, defineAction } from "@hearth/kernel";
import { z } from "zod";
import { resolveRef, runGit, short } from "./git.ts";
import { commits, LINE_CHARS, refField, repoField } from "./history.ts";
import { cleanPath, isSecret, literal, SECRET_WORDS, secretSpecs } from "./paths.ts";
import { checkRepo, openRepo, readRepos } from "./repos.ts";

const WINDOWS = process.platform === "win32";

/** The most lines one read returns. */
export const READ_LINES = 400;
/** A file bigger than this isn't read from the working tree. */
export const READ_BYTES = 4 * 1024 * 1024;
/** The most search hits, and folder entries, one call returns. */
export const SEARCH_HITS = 200;
const ENTRIES = 500;

/** One repo as Settings and Pip see it: its branch and last commit, or what's wrong. */
async function aboutRepo(stored: string) {
  const checked = checkRepo(stored);
  const none = { name: basename(stored), path: stored, branch: null, head: null };
  if ("refused" in checked) return { ...none, problem: checked.refused };
  const path = checked.path;
  try {
    const branch = await runGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      ok: [1, 128],
    });
    const head = await runGit(path, ["rev-parse", "--verify", "--quiet", "HEAD"], { ok: [1, 128] });
    const sha = head.code === 0 ? head.text.trim() : null;
    const last = sha ? (await commits(path, sha, { limit: 1 })).commits[0] : undefined;
    return {
      name: basename(path),
      path,
      branch: branch.code === 0 ? branch.text.trim() : sha ? `detached at ${short(sha)}` : null,
      head: last ?? null,
      problem: null,
    };
  } catch (err) {
    return { ...none, problem: (err as Error).message };
  }
}

/** A text file's lines from start, numbered, each cut at LINE_CHARS. */
function window(text: string, start: number, count: number) {
  const all = text.split(/\r?\n/);
  if (all.at(-1) === "") all.pop();
  const lines = all.slice(start - 1, start - 1 + count);
  const end = start + lines.length - 1;
  return {
    from: start,
    to: end,
    total: all.length,
    text: lines.map((l, k) => `${start + k}\t${l.slice(0, LINE_CHARS)}`).join("\n"),
    ...(end < all.length && {
      more: `Lines ${start}-${end} of ${all.length}. Ask with start: ${end + 1} for more.`,
    }),
  };
}

const looksBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

const tooBig = (path: string) =>
  new ActionError(
    "invalid_input",
    `${path} is over ${READ_BYTES / 1048576} MB, too big to read. Search it with code_search.`,
  );

/** What's in a folder, one level: files, and folders ending in "/". */
async function folder(repo: string, sha: string | null, path: string) {
  const at = sha ?? "HEAD";
  const tree = await runGit(repo, ["ls-tree", "-z", at, ...(path ? ["--", `${path}/`] : [])], {
    ok: [128],
  });
  const names = new Set<string>();
  for (const row of tree.text.split("\0")) {
    const m = /^\d+ (\w+) [0-9a-f]+\t(.+)$/.exec(row);
    if (m) names.add(`${m[2]!.split("/").at(-1)}${m[1] === "tree" ? "/" : ""}`);
  }
  // From the working tree, files git would add too (not yet committed, and not ignored).
  if (!sha) {
    const spec = path ? ["--", literal(`${path}/`)] : [];
    const added = await runGit(repo, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--directory",
      "-z",
      ...spec,
    ]);
    const prefix = path ? `${path}/` : "";
    for (const p of added.text.split("\0")) {
      const rest = p.startsWith(prefix) ? p.slice(prefix.length) : "";
      const [first, ...deeper] = rest.split("/");
      if (first) names.add(deeper.length ? `${first}/` : first);
    }
  }
  const entries = [...names].sort();
  return { entries: entries.slice(0, ENTRIES), truncated: entries.length > ENTRIES };
}

/** A file from the working tree, if git tracks it or would add it, and it stays in the repo. */
async function workingFile(repo: string, path: string) {
  const listed = await runGit(repo, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    literal(path),
  ]);
  const paths = listed.text.split("\0").filter(Boolean);
  const exact =
    paths.find((p) => p === path) ??
    (paths.length === 1 && paths[0]!.toLowerCase() === path.toLowerCase() ? paths[0] : undefined);
  if (!exact) {
    if (paths.some((p) => p.startsWith(`${path}/`))) return folder(repo, null, path);
    throw new ActionError(
      "not_found",
      `There's no ${path} in this repo that git tracks or would add. Ignored files stay out.`,
    );
  }
  // A link can point anywhere, even at git's own config or an ignored file, so none is followed:
  // the file read is the one at exactly this place, and never one in git's own folder.
  const top = await realpath(repo);
  const want = join(top, exact);
  const real = await realpath(want);
  const same = WINDOWS ? real.toLowerCase() === want.toLowerCase() : real === want;
  const parts = relative(top, real).split(sep);
  const info = await stat(real);
  const gits = parts.some((s) => s.toLowerCase() === ".git");
  if (!same || gits || isSecret(parts.join("/")) || !info.isFile())
    throw new ActionError("forbidden", `${path} is a link, or a file Pip doesn't read.`);
  if (info.size > READ_BYTES) throw tooBig(path);
  const handle = await open(real, "r");
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export const readingActions = [
  defineAction({
    name: "code.repos",
    description:
      "The code repos the owner has let you read, each with its name, folder, branch and last commit. Use a repo's name with code_log, code_diff, code_blame, code_search and code_read; all of them only read, and none asks first. Nook's own code is never one of them.",
    input: z.object({}),
    risk: "read",
    callers: ["owner", "agent"],
    external: true,
    io: true,
    async handler(_i, ctx) {
      const repos = await Promise.all((await readRepos(ctx.tx)).map(aboutRepo));
      return repos.length
        ? { repos, outside: true }
        : { repos, note: "No repos yet. The owner adds them in Settings, under Code." };
    },
  }),
  defineAction({
    name: "code.search",
    description: `Searches a repo's files git tracks for exact text (not a pattern): each hit's file, line number and line. From the working tree, or as of a branch, tag or commit; optionally only under a path. At most ${SEARCH_HITS} hits; files that may hold secrets are left out. Reads only, without asking; the code counts as outside content.`,
    input: z.object({
      repo: repoField,
      text: z
        .string()
        .min(1)
        .max(200)
        .refine((t) => !/[\r\n]/.test(t), "One line of text.")
        .describe("The exact text to find."),
      path: z.string().trim().max(500).optional().describe("Only under this file or folder."),
      ref: refField
        .optional()
        .describe("Search as of this branch, tag or commit, not the working tree."),
      ignoreCase: z.boolean().default(false),
      limit: z.number().int().min(1).max(SEARCH_HITS).default(50),
    }),
    risk: "read",
    callers: ["owner", "agent"],
    external: true,
    io: true,
    async handler(i, ctx) {
      const repo = await openRepo(ctx.tx, i.repo);
      const path = cleanPath(i.path);
      const sha = i.ref ? await resolveRef(repo.path, i.ref) : null;
      const out = await runGit(
        repo.path,
        [
          "grep",
          "-n",
          "-I",
          "-F",
          "-z",
          "--full-name",
          ...(i.ignoreCase ? ["-i"] : []),
          "-e",
          i.text,
          ...(sha ? [sha] : []),
          "--",
          ...(path ? [literal(path)] : []),
          // Git never searches a file that may hold secrets, so nothing (not even a count of hits)
          // could tell Pip what one says.
          ...secretSpecs(),
        ],
        { ok: [1], maxBytes: 512 * 1024 },
      );
      const hits: { path: string; line: number; text: string }[] = [];
      for (const row of out.text.split("\n")) {
        const [file = "", line = "", text = ""] = row.split("\0");
        if (!line) continue;
        const p = sha && file.startsWith(`${sha}:`) ? file.slice(sha.length + 1) : file;
        if (!isSecret(p))
          hits.push({ path: p, line: Number(line), text: text.trim().slice(0, 300) });
      }
      return {
        repo: repo.name,
        hits: hits.slice(0, i.limit),
        more: hits.length > i.limit || out.truncated,
        outside: true,
      };
    },
  }),
  defineAction({
    name: "code.read",
    description: `Reads a file in a repo: up to ${READ_LINES} numbered lines from start (200 unless you say). Given a folder (or no path, for the top), lists what's in it instead, folders ending in "/". From the working tree, only files git tracks or would add; or as of a branch, tag or commit. Not for files that may hold secrets. Reads only, without asking; the code counts as outside content.`,
    input: z.object({
      repo: repoField,
      path: z
        .string()
        .trim()
        .max(500)
        .optional()
        .describe(
          "A file or folder from the repo's top, like src/app.ts. The top folder if left out.",
        ),
      ref: refField
        .optional()
        .describe("Read it as of this branch, tag or commit, not the working tree."),
      start: z.number().int().min(1).default(1),
      lines: z.number().int().min(1).max(READ_LINES).default(200),
    }),
    risk: "read",
    callers: ["owner", "agent"],
    external: true,
    io: true,
    async handler(i, ctx) {
      const repo = await openRepo(ctx.tx, i.repo);
      const path = cleanPath(i.path);
      const sha = i.ref ? await resolveRef(repo.path, i.ref) : null;
      const where = { repo: repo.name, path: path || ".", ...(i.ref ? { ref: i.ref } : {}) };
      if (!path) return { ...where, ...(await folder(repo.path, sha, "")), outside: true };
      if (isSecret(path)) throw new ActionError("forbidden", SECRET_WORDS);
      let bytes: Buffer;
      if (sha) {
        const kind = await runGit(repo.path, ["cat-file", "-t", `${sha}:${path}`], { ok: [128] });
        const type = kind.code === 0 ? kind.text.trim() : "";
        if (type === "tree")
          return { ...where, ...(await folder(repo.path, sha, path)), outside: true };
        if (type !== "blob")
          throw new ActionError("not_found", `There's no file ${path} in ${i.ref}.`);
        const out = await runGit(repo.path, ["cat-file", "blob", `${sha}:${path}`], {
          maxBytes: READ_BYTES,
        });
        if (out.truncated) throw tooBig(path);
        bytes = Buffer.from(out.text, "utf8");
      } else {
        const got = await workingFile(repo.path, path);
        if (!Buffer.isBuffer(got)) return { ...where, ...got, outside: true };
        bytes = got;
      }
      if (looksBinary(bytes))
        throw new ActionError("invalid_input", `${path} is a binary file, so it isn't shown.`);
      return { ...where, ...window(bytes.toString("utf8"), i.start, i.lines), outside: true };
    },
  }),
];
