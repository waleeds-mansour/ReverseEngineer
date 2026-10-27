// What Pip may name in a repo: a ref and a path. Each is checked before git sees it, so nothing
// it passes reads as an option, leaves the repo, or reaches a file that may hold secrets. Pip sees
// what it reads, so a key or a .env file stays out even in a repo you added.
import { ActionError } from "@hearth/kernel";

/** Why a file Pip asked for isn't shown. */
export const SECRET_WORDS =
  "Pip doesn't read files that may hold secrets: .env files, keys, certificates and credentials.";

/**
 * Files that may hold secrets, as git globs from the repo's top ("**\/" is any folder, "*" any
 * part of a name), matched without case. The same list decides here (isSecret) and keeps them out
 * of git's own search (secretSpecs), so a search never touches them at all.
 */
const SECRET_GLOBS = [
  // Folders of keys and tokens.
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.aws/**",
  // Environment files.
  "**/.env*",
  "**/*.env",
  // Keys, certificates and key stores.
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  ...["pem", "key", "p8", "p12", "pfx", "pkcs12", "ppk", "jks", "keystore", "kdbx"].map(
    (e) => `**/*.${e}`,
  ),
  ...["gpg", "asc", "ovpn"].map((e) => `**/*.${e}`),
  // Credentials, and the dotfiles and settings that keep tokens.
  "**/*credential*",
  "**/service-account*.json",
  "**/secrets.*",
  ...["json", "yaml", "yml", "toml", "ini", "txt", "xml"].map((e) => `**/secret.${e}`),
  ...[".netrc", "_netrc", ".npmrc", ".pypirc", ".pgpass", ".htpasswd", ".yarnrc.yml"].map(
    (f) => `**/${f}`,
  ),
  "**/.docker/config.json",
  "**/.kube/config",
  "**/.config/gh/hosts.yml",
  "**/*.tfstate*",
  "**/*.tfvars",
  "**/appsettings.*.json",
  "**/wp-config.php",
];

/** A git glob as a regex over a lower-cased repo path. */
function globRegex(glob: string): RegExp {
  let rest = glob.toLowerCase();
  let re = "";
  if (rest.startsWith("**/")) {
    re = "(?:.*/)?";
    rest = rest.slice(3);
  }
  const inside = rest.endsWith("/**");
  if (inside) rest = rest.slice(0, -3);
  re += rest
    .split("*")
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${re}${inside ? "/.*" : ""}$`);
}

const SECRET_RES = SECRET_GLOBS.map(globRegex);

/** Whether a repo path (with / between folders) may hold secrets. Case doesn't matter. */
export const isSecret = (path: string): boolean => {
  const p = path.replaceAll("\\", "/").toLowerCase();
  return SECRET_RES.some((r) => r.test(p));
};

/** Pathspecs that keep every file that may hold secrets out of what git reads. */
export const secretSpecs = (): string[] => SECRET_GLOBS.map((g) => `:(exclude,icase,glob)${g}`);

const bad = (message: string) => new ActionError("invalid_input", message);

/**
 * A path inside the repo, as git writes it (a/b.ts), or "" for the repo's top folder. Refuses
 * one that starts with "-", is absolute, steps out with "..", names git's own folder, or has
 * what Windows would quietly drop or read as a stream (a trailing dot or space, a ":").
 */
export function cleanPath(raw: string | undefined): string {
  const given = (raw ?? "").trim();
  const p = given.replaceAll("\\", "/");
  if (p.startsWith("-")) throw bad(`"${given}" isn't a path: a path never starts with "-".`);
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p))
    throw bad("Give a path inside the repo, like src/app.ts, not one from the drive.");
  const control = [...p].some((c) => c.charCodeAt(0) < 32);
  if (p.length > 500 || control || /[:*?"<>|]/.test(p))
    throw bad(`"${given}" has characters a repo path can't have.`);
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts[0]?.startsWith("-"))
    throw bad(`"${given}" isn't a path: a path never starts with "-".`);
  if (parts.includes("..")) throw bad("A path can't leave the repo, so it can't have \"..\".");
  if (parts.some((s) => s.toLowerCase() === ".git"))
    throw bad("Pip doesn't read git's own folder, which can hold sign-ins.");
  if (parts.some((s) => /[. ]$/.test(s)))
    throw bad(`"${given}" ends a name with a dot or space, which Windows would drop.`);
  return parts.join("/");
}

/**
 * A ref as Pip may name it: a branch, a tag, a commit, HEAD~2, main^, v1.0. Never one that starts
 * with "-" (git would take it for an option), a range ("..") or a path (":").
 */
export function cleanRef(raw: string): string {
  const r = raw.trim();
  if (r.startsWith("-")) throw bad(`"${r}" isn't a ref: a ref never starts with "-".`);
  if (!r || r.length > 200 || !/^[\w./@^~{}+-]+$/.test(r) || r.includes(".."))
    throw bad(`"${r}" isn't a ref. Use a branch, a tag or a commit, like main, v1.2 or HEAD~2.`);
  return r;
}

/** A pathspec git reads as exactly this path (or folder), with no wildcards or magic. */
export const literal = (path: string) => `:(literal)${path}`;
