// A throwaway git repo for code.*'s tests, in the OS temp folder and removed after: a README, a
// 300-line source file, a .env with a made-up token, an ignored file and one not yet committed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Fixture {
  /** The repo's folder. */
  dir: string;
  /** The temp folder it's in, where nothing of the repo's reaches. */
  root: string;
  first: string;
  second: string;
  git(...args: string[]): string;
  write(path: string, text: string): void;
  commit(message: string): string;
  destroy(): void;
}

/** The made-up token in .env, which no action may ever return. */
export const SECRET = "needle-secret";

export const APP_LINES = 300;

export function makeRepo(name = "demo"): Fixture {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "hearth-code-")));
  const dir = join(root, name);
  mkdirSync(dir);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Ann Lee",
        "-c",
        "user.email=ann@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.autocrlf=false",
        "-c",
        `core.hooksPath=${join(root, "no-hooks")}`,
        ...args,
      ],
      { cwd: dir, encoding: "utf8", windowsHide: true },
    );
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q", "-b", "main");
  write("README.md", "# Demo\nHello needle\n");
  const app = Array.from({ length: APP_LINES }, (_, k) =>
    k === 6 ? "// needle here" : `export const v${k + 1} = ${k + 1};`,
  );
  write("src/app.ts", `${app.join("\n")}\n`);
  write(".env", `TOKEN=${SECRET}\n`);
  write(".gitignore", "local.txt\n");
  const first = commit("First commit");
  app[1] = "export const changed = 2;";
  write("src/app.ts", `${app.join("\n")}\n`);
  write(".env", `TOKEN=${SECRET}-2\n`);
  const second = commit("Second commit");
  write("local.txt", "ignored needle\n");
  write("notes/new.md", "not yet committed needle\n");
  return {
    dir,
    root,
    first,
    second,
    git,
    write,
    commit,
    destroy: () => rmSync(root, { recursive: true, force: true }),
  };
}
