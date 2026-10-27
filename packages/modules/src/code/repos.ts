// The repos you let Pip read (Spec 2): folders you add yourself in Settings, never by Pip. Each is
// checked when you add it and again on every read: it's still there and still a git repo, and it
// isn't Nook's own code or data, a system folder, or your whole user folder. Nook's own repo stays
// out wherever it's checked out: by where this copy runs from, by its remotes, and by its shape.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type DbOrTx, setting } from "@hearth/db";
import { ActionError } from "@hearth/kernel";
import { eq } from "drizzle-orm";

/** The setting that lists them: absolute folders, as you added them once resolved. */
export const REPOS_KEY = "code.repos";

/** Where this copy of Nook runs from (the live install, or a checkout): its own source. */
export const NOOK_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");

/** Nook's repo on GitHub, under each name it has had. A clone of it anywhere stays out. */
const NOOK_REMOTES = [
  "github.com/wallythepenguin/reverseengineer",
  "github.com/waleeds-mansour/reverseengineer",
];

export async function readRepos(db: DbOrTx): Promise<string[]> {
  const [row] = await db.select().from(setting).where(eq(setting.key, REPOS_KEY));
  const value = row?.value;
  return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
}

export async function writeRepos(db: DbOrTx, repos: string[], now: Date): Promise<void> {
  await db
    .insert(setting)
    .values({ key: REPOS_KEY, value: repos, updatedAt: now })
    .onConflictDoUpdate({ target: setting.key, set: { value: repos, updatedAt: now } });
}

/** Whether `child` is `parent` or inside it. Windows compares without case. */
export function inside(child: string, parent: string): boolean {
  const r = relative(parent, child);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
}

export const samePath = (a: string, b: string) => inside(a, b) && inside(b, a);

/** A remote's address without its scheme, sign-in or .git: github.com/owner/name. */
export function remoteKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .replace(/\/+$/, "")
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\/)/, "$1/");
}

/** A remote that's a folder on this PC (a path, or a file:// address), as a path. */
function localRemote(url: string): string | null {
  try {
    if (url.startsWith("file://")) return fileURLToPath(url);
  } catch {
    return null;
  }
  return isAbsolute(url) ? resolve(url) : null;
}

/**
 * The folders git keeps a repo in, as they really are: its own (.git, or where a .git file points)
 * and the common one a worktree shares with its main repo, which holds the config. Null if .git is
 * a file that points nowhere.
 */
function gitDirs(repo: string): { dir: string; common: string } | null {
  const dotGit = join(repo, ".git");
  let dir = dotGit;
  if (statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    dir = resolve(repo, m[1]!.trim());
  }
  const file = join(dir, "commondir");
  const common = existsSync(file) ? resolve(dir, readFileSync(file, "utf8").trim()) : dir;
  return { dir: real(dir), common: real(common) };
}

/** Every remote's address in a repo's own config, read from the file: no git, nothing run. */
export function remotesOf(repo: string): string[] {
  try {
    const dir = gitDirs(repo)?.common;
    if (!dir) return [];
    const text = readFileSync(join(dir, "config"), "utf8");
    let inRemote = false;
    const urls: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]*)\]/.exec(line);
      if (section) inRemote = /^remote\b/i.test(section[1]!.trim());
      const url = /^\s*(?:push)?url\s*=\s*(.+?)\s*$/i.exec(line);
      if (inRemote && url) urls.push(url[1]!.replace(/^"(.*)"$/, "$1"));
    }
    return urls;
  } catch {
    return [];
  }
}

/** A package.json's name, or null. */
function packageName(dir: string): string | null {
  try {
    const name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown })
      .name;
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

const KEY_DIRS = new Set([".ssh", ".gnupg", ".aws"]);

/** Where no repo of yours lives: Windows, programs, app settings, and keys in any account. */
function systemPlace(path: string, env: NodeJS.ProcessEnv): boolean {
  const named = [
    env.SystemRoot,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.ProgramData,
    env.APPDATA,
  ];
  const posix =
    process.platform === "win32"
      ? []
      : ["/etc", "/usr", "/bin", "/sbin", "/lib", "/proc", "/sys", "/boot", "/dev"];
  if ([...named, ...posix].some((d) => d && inside(path, d))) return true;
  // By name too: Nook's server runs as its own Windows account, so these may be yours, not its.
  const parts = path.toLowerCase().split(/[\\/]/);
  return parts.some((p, k) => KEY_DIRS.has(p) || (p === "appdata" && parts[k + 1] === "roaming"));
}

/** A drive's top, or a whole account's folder: any account's, whichever Nook runs as. */
function tooBroad(path: string): boolean {
  if (parse(path).root === path || inside(homedir(), path)) return true;
  const up = dirname(path);
  return (
    (basename(up).toLowerCase() === "users" && parse(up).root === dirname(up)) || up === "/home"
  );
}

const NOOK_OWN =
  "That's Nook's own code. It stays out of what Pip reads, wherever it's checked out.";

/** Where the live Nook is installed on the owner's PC, whichever copy this is. */
const LIVE = process.platform === "win32" ? [resolve("D:\\Hearth")] : [];

/** A folder as it really is, links and junctions followed, when it's there. */
function real(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * The folder as it really is (links and junctions followed), or why Pip may not read it as a
 * repo. `root` is where this copy of Nook runs from.
 */
export function checkRepo(
  given: string,
  env: NodeJS.ProcessEnv = process.env,
  root: string = NOOK_ROOT,
): { path: string } | { refused: string } {
  const raw = given.trim();
  if (!isAbsolute(raw) || /^[\\/]{2}/.test(raw))
    return { refused: "Give the repo's whole folder on this PC, like D:\\code\\my-app." };
  let path: string;
  try {
    path = realpathSync.native(raw);
    if (!statSync(path).isDirectory()) return { refused: `${raw} is a file, not a folder.` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EACCES" || code === "EPERM"
      ? { refused: `Nook isn't allowed to open ${raw}.` }
      : { refused: `There's no folder at ${raw}.` };
  }
  if (!existsSync(join(path, ".git")))
    return { refused: `${path} isn't a git repo. Add the folder that has .git in it.` };
  // Nook's own: where it runs from, the live install, its data, and its backups, whichever holds
  // the other. The live install is only named, never opened.
  const nook = real(root);
  const data = [env.HEARTH_DATA_DIR, env.HEARTH_BACKUP_DIR].filter((d): d is string => Boolean(d));
  const own = [nook, ...LIVE, ...data.map(real)];
  if (own.some((d) => inside(path, d) || inside(d, path))) return { refused: NOOK_OWN };
  // A folder whose .git is a file pointing into Nook's own (a worktree of it): git would read
  // Nook's repo, whatever the folder's name or remotes.
  let dirs: ReturnType<typeof gitDirs>;
  try {
    dirs = gitDirs(path);
  } catch {
    dirs = null;
  }
  if (!dirs) return { refused: `${path} isn't a git repo. Add the folder that has .git in it.` };
  if ([dirs.dir, dirs.common].some((g) => own.some((d) => inside(g, d))))
    return { refused: NOOK_OWN };
  if (tooBroad(path))
    return { refused: "That folder holds far more than one repo. Add the repo's own folder." };
  if (systemPlace(path, env))
    return { refused: "That's a system or settings folder, not one of your repos." };
  const ownRemotes = new Set([...NOOK_REMOTES, ...remotesOf(root).map(remoteKey)]);
  for (const url of remotesOf(path)) {
    if (ownRemotes.has(remoteKey(url))) return { refused: NOOK_OWN };
    // A clone of a checkout of Nook, by its folder.
    const local = localRemote(url);
    if (local && inside(real(local), nook)) return { refused: NOOK_OWN };
  }
  // A copy of Nook's source with no remote: its package and its kernel.
  const name = packageName(root);
  if (name && packageName(path) === name && existsSync(join(path, "packages", "kernel")))
    return { refused: NOOK_OWN };
  return { path };
}

export interface OpenRepo {
  name: string;
  path: string;
}

/**
 * The repo Pip named, by its name or folder, checked again now: it may have moved, or changed
 * since you added it. Only repos you added are ever opened.
 */
export async function openRepo(db: DbOrTx, given: string): Promise<OpenRepo> {
  const repos = await readRepos(db);
  if (repos.length === 0)
    throw new ActionError(
      "not_found",
      "No repos are open to Pip yet. The owner adds them in Settings, under Code.",
    );
  const g = given.trim();
  const byPath = repos.filter((p) => isAbsolute(g) && samePath(p, g));
  const found = byPath.length
    ? byPath
    : repos.filter((p) => basename(p).toLowerCase() === g.toLowerCase());
  const names = repos.map((p) => `${basename(p)} (${p})`).join(", ");
  if (found.length === 0)
    throw new ActionError("not_found", `"${g}" isn't a repo Pip can read. These are: ${names}.`);
  if (found.length > 1)
    throw new ActionError("invalid_input", `More than one repo is called "${g}"; give its folder.`);
  const checked = checkRepo(found[0]!);
  if ("refused" in checked) throw new ActionError("forbidden", checked.refused);
  return { name: basename(checked.path), path: checked.path };
}
