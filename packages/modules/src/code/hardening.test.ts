// What a repo you added can't make git or Nook do: run a git.exe it keeps in its folder, reach git's
// own folder or an ignored file through a link, show a file with secrets by another usual name,
// point git at files elsewhere on this PC, quote a file back in an error, or pass as a repo of its
// own while git reads Nook's. And git stops when Nook stops it, a few at a time.
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { type Fixture, makeRepo, SECRET } from "./fixture.ts";
import { findGit, gitPath, runGit, slots, stopTree } from "./git.ts";
import { checkRepo, inside } from "./repos.ts";
import { BUSY, Slots } from "./slots.ts";

const WINDOWS = process.platform === "win32";
const SLOW = 60_000;
const pip = jarvisCaller("owner");

let t: TestKernel;
let repo: Fixture;
beforeAll(() => {
  repo = makeRepo("hard");
});
afterAll(() => repo.destroy());
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  expect((await run("code.add", { path: repo.dir })).status).toBe("ok");
});
afterEach(async () => {
  await t.destroy();
});

const run = (name: string, input: unknown, caller: Caller = ownerCaller()) =>
  t.kernel.execute<Record<string, unknown>>(name, input, caller);

/** A folder in the OS temp folder, removed by the caller. */
const scratch = () => realpathSync.native(mkdtempSync(join(tmpdir(), "hearth-code-")));

/** Whether this PC lets a test make a file link (Windows needs Developer Mode or admin). */
function canLink(): boolean {
  const d = scratch();
  try {
    symlinkSync(join(d, "a"), join(d, "b"), "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe("git's own program", () => {
  it("is found on PATH's full folders only, and is Git for Windows' real git", () => {
    const d = scratch();
    try {
      for (const f of ["here/git.exe", "real/cmd/git.exe", "real/mingw64/bin/git.exe", "nix/git"]) {
        mkdirSync(join(d, f, ".."), { recursive: true });
        writeFileSync(join(d, f), "");
      }
      const path = [".", "here", join(d, "empty"), join(d, "real", "cmd"), join(d, "here")];
      expect(findGit({ Path: path.join(delimiter) }, true)).toBe(
        join(d, "real", "mingw64", "bin", "git.exe"),
      );
      expect(findGit({ PATH: [".", join(d, "here")].join(delimiter) }, true)).toBe(
        join(d, "here", "git.exe"),
      );
      expect(findGit({ PATH: join(d, "nix") }, false)).toBe(join(d, "nix", "git"));
      expect(findGit({ PATH: `.${delimiter}here` }, true)).toBeNull();
      expect(findGit({}, true)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it(
    "runs, never a git a repo keeps in its folder",
    async () => {
      const git = gitPath();
      expect(isAbsolute(git)).toBe(true);
      expect(inside(git, repo.root)).toBe(false);
      if (WINDOWS) expect(git.toLowerCase()).not.toMatch(/\\cmd\\git\.exe$/);
      // Not programs at all: had Windows started one, git's work would fail.
      const planted = ["git.exe", "git.com", "git", "git.cmd", "git.bat"];
      for (const f of planted) repo.write(f, "MZ no\n");
      // Windows skips the current folder when this process says so, as a terminal may; Nook's
      // server doesn't, so neither does this test.
      const skipCwd = process.env.NoDefaultCurrentDirectoryInExePath;
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      try {
        for (const [name, input] of [
          ["code.repos", {}],
          ["code.log", { repo: "hard" }],
          ["code.read", { repo: "hard", path: "README.md" }],
          ["code.search", { repo: "hard", text: "needle" }],
        ] as const) {
          expect((await run(name, input, pip)).status, name).toBe("ok");
        }
        const read = await run("code.read", { repo: "hard", path: "README.md" }, pip);
        expect(read).toMatchObject({ result: { text: "1\t# Demo\n2\tHello needle" } });
      } finally {
        if (skipCwd !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = skipCwd;
        for (const f of planted) rmSync(join(repo.dir, f), { force: true });
      }
    },
    SLOW,
  );
});

describe("links in a repo", () => {
  it.skipIf(!canLink())("are never followed to git's own folder or an ignored file", async () => {
    mkdirSync(join(repo.dir, "docs"), { recursive: true });
    const links = {
      "notes.txt": [".git", "config"],
      "local.txt": ["local.txt"],
      "env.txt": [".env"],
    };
    try {
      for (const [name, to] of Object.entries(links))
        symlinkSync(join("..", ...to), join(repo.dir, "docs", name), "file");
      for (const name of Object.keys(links)) {
        const res = await run("code.read", { repo: "hard", path: `docs/${name}` }, pip);
        expect(res, name).toMatchObject({ status: "error" });
        expect(JSON.stringify(res), name).not.toMatch(/repositoryformatversion|ignored|needle/);
      }
    } finally {
      for (const name of Object.keys(links)) rmSync(join(repo.dir, "docs", name), { force: true });
    }
  });

  it("are never followed into git's own folder, a junction or folder link too", async () => {
    // A junction needs no rights on Windows; elsewhere it's a plain folder link.
    symlinkSync(join(repo.dir, ".git"), join(repo.dir, "gitlink"), "junction");
    symlinkSync(join(repo.dir, "src"), join(repo.dir, "srclink"), "junction");
    try {
      for (const path of ["gitlink/config", "gitlink/HEAD", "srclink/app.ts"]) {
        const res = await run("code.read", { repo: "hard", path }, pip);
        expect(res, path).toMatchObject({ status: "error" });
        expect(JSON.stringify(res), path).not.toMatch(/repositoryformatversion|refs\/heads|v1 = 1/);
      }
    } finally {
      // Not recursive: only the links go, never what they lead to.
      for (const link of ["gitlink", "srclink"]) rmSync(join(repo.dir, link), { force: true });
    }
  });
});

describe("files with secrets by their other usual names", () => {
  it(
    "stay out of search, by any case, at the working tree or a commit",
    async () => {
      const names = ["deploy/prod.tfvars", ".docker/config.json", "Secrets.YML", "a/.KUBE/config"];
      names.push("infra/terraform.tfstate.backup", "appsettings.Production.json", "key.ASC");
      for (const name of names) repo.write(name, `token = "${SECRET}"\n`);
      repo.commit("Settings");
      try {
        const nothing = await run("code.search", { repo: "hard", text: "zz-nowhere" }, pip);
        for (const ref of [undefined, "HEAD"])
          for (const text of [SECRET, "TOKEN"]) {
            const res = await run(
              "code.search",
              { repo: "hard", text, ref, ignoreCase: true },
              pip,
            );
            expect(res, `${text} ${ref}`).toEqual(nothing);
          }
        for (const name of names)
          expect(await run("code.read", { repo: "hard", path: name }, pip), name).toMatchObject({
            code: "forbidden",
          });
        const diff = await run("code.diff", { repo: "hard", commit: "HEAD" }, pip);
        expect(diff.status).toBe("ok");
        expect(JSON.stringify(diff)).not.toContain(SECRET);
      } finally {
        repo.git("reset", "-q", "--hard", "HEAD~1");
      }
    },
    SLOW,
  );
});

describe("a repo's config naming files elsewhere", () => {
  it(
    "isn't followed, and git's errors never quote a file",
    async () => {
      const revs = join(repo.root, "revs.txt");
      writeFileSync(revs, `${SECRET}\n`);
      writeFileSync(join(repo.root, "map"), "Mallory <m@example.com> Ann Lee <ann@example.com>\n");
      repo.git("config", "blame.ignoreRevsFile", revs);
      repo.git("config", "mailmap.file", join(repo.root, "map"));
      repo.git("config", "diff.orderFile", join(repo.root, "nowhere", "order.txt"));
      try {
        const blame = await run("code.blame", { repo: "hard", path: "README.md" }, pip);
        const lines = blame.status === "ok" ? (blame.result.lines as { author: string }[]) : [];
        expect(lines.map((l) => l.author)).toEqual(["Ann Lee", "Ann Lee"]);
        const diff = await run("code.diff", { repo: "hard", commit: "HEAD" }, pip);
        expect(diff.status).toBe("ok");
        // Without the guard, git fails quoting the file: "invalid object name: needle-secret".
        const raw = await runGit(repo.dir, [
          "blame",
          "--porcelain",
          "HEAD",
          "--",
          "README.md",
        ]).then(
          () => null,
          (err: Error) => err.message,
        );
        expect(raw).toBe("Git couldn't find that commit.");
        const short = await run("code.blame", { repo: "hard", path: "README.md", start: 50 }, pip);
        expect(short).toMatchObject({ message: "That file has only 2 lines." });
      } finally {
        for (const key of ["blame.ignoreRevsFile", "mailmap.file", "diff.orderFile"])
          repo.git("config", "--unset", key);
      }
    },
    SLOW,
  );
});

describe("a folder whose .git points into Nook's own", () => {
  it("is refused, by its git folder or the common one, and others aren't", () => {
    const d = scratch();
    try {
      const nook = join(d, "nook");
      const wtDir = join(nook, ".git", "worktrees", "wt");
      mkdirSync(wtDir, { recursive: true });
      writeFileSync(join(nook, ".git", "config"), "[core]\n");
      writeFileSync(join(wtDir, "commondir"), "../..\n");
      const linked = (name: string, gitdir: string) => {
        mkdirSync(join(d, name));
        writeFileSync(join(d, name, ".git"), `gitdir: ${gitdir}\n`);
        return join(d, name);
      };
      const own = { refused: expect.stringContaining("Nook's own") };
      expect(checkRepo(linked("wt", wtDir), {}, nook)).toEqual(own);
      const shared = join(d, "elsewhere");
      mkdirSync(shared);
      writeFileSync(join(shared, "commondir"), join(nook, ".git"));
      expect(checkRepo(linked("wt2", shared), {}, nook)).toEqual(own);
      const fine = join(d, "fine-git");
      mkdirSync(fine);
      expect(checkRepo(linked("wt3", fine), {}, nook)).toEqual({ path: join(d, "wt3") });
      writeFileSync(join(d, "wt3", ".git"), "not a pointer\n");
      expect(checkRepo(join(d, "wt3"), {}, nook)).toMatchObject({ refused: expect.any(String) });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("how many gits run", () => {
  it("is 4 in all and 2 per repo; a few wait, more fail at once", async () => {
    const s = new Slots(4, 2, 2, 300);
    const a1 = await s.take("a");
    await s.take("a");
    let third = false;
    const a3 = s.take("a").then((done) => {
      third = true;
      return done;
    });
    await s.take("b");
    await s.take("c");
    expect(s.busy).toBe(4);
    const d1 = s.take("d");
    d1.catch(() => {});
    await expect(s.take("e")).rejects.toThrow(BUSY);
    expect(third).toBe(false);
    a1();
    a1();
    await a3;
    expect(third).toBe(true);
    expect(s.busy).toBe(4);
    // Waiting too long fails too, with the same words.
    await expect(d1).rejects.toThrow(BUSY);
  });

  it(
    "lets many reads at once all finish, and frees every turn",
    async () => {
      const calls = Array.from({ length: 12 }, (_, k) =>
        run("code.log", { repo: "hard", limit: 1 + k }, pip),
      );
      for (const res of await Promise.all(calls)) expect(res.status).toBe("ok");
      expect(slots.busy).toBe(0);
    },
    SLOW,
  );
});

describe("stopping git", () => {
  it.runIf(WINDOWS)("stops what it started too", async () => {
    const d = scratch();
    const file = join(d, "beat.txt");
    // A program that starts another, which writes every 50 ms and gives up after 10 s.
    const inner = `const f=require("fs");setInterval(()=>f.appendFileSync(${JSON.stringify(file)},"x"),50);setTimeout(()=>process.exit(),10000)`;
    const outer = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(inner)}],{stdio:"ignore",windowsHide:true});setTimeout(()=>{},10000)`;
    try {
      const child = spawn(process.execPath, ["-e", outer], { stdio: "ignore", windowsHide: true });
      for (let k = 0; k < 100 && !existsSync(file); k++) await sleep(50);
      expect(existsSync(file)).toBe(true);
      stopTree(child);
      await once(child, "close");
      await sleep(300);
      const size = statSync(file).size;
      await sleep(400);
      expect(statSync(file).size).toBe(size);
    } finally {
      await sleep(100);
      rmSync(d, { recursive: true, force: true });
    }
  });
});
