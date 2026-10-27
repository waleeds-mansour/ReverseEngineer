// What keeps Pip's reading of code safe: only repos you add, never Nook's own; refs and paths that
// can't turn into options or leave the repo; files that may hold secrets never shown; a repo's
// config never running a program; capped output; and none of it waiting for your yes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActionDef,
  type Caller,
  decide,
  jarvisCaller,
  ownerCaller,
  setSetting,
} from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { type Fixture, makeRepo, SECRET } from "./fixture.ts";
import { DIFF_CHARS } from "./history.ts";
import { codeModule, isSecret, NOOK_ROOT } from "./index.ts";

let t: TestKernel;
let repo: Fixture;
beforeAll(() => {
  repo = makeRepo();
});
afterAll(() => repo.destroy());
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  expect((await run("code.add", { path: repo.dir })).status).toBe("ok");
});
afterEach(async () => {
  await t.destroy();
});

const pip = jarvisCaller("owner");
/** For a test that makes throwaway repos and runs git dozens of times: seconds on Windows. */
const SLOW = 60_000;
const run = (name: string, input: unknown, caller: Caller = ownerCaller()) =>
  t.kernel.execute<Record<string, unknown>>(name, input, caller);

describe("adding a repo", () => {
  it(
    "refuses Nook's own code: where it runs from, a clone by its remote, a copy by its shape",
    async () => {
      const own = await run("code.add", { path: NOOK_ROOT });
      expect(own).toMatchObject({ status: "error", code: "invalid_input" });
      expect(JSON.stringify(own)).toContain("Nook's own code");
      const clone = makeRepo("clone");
      const copy = makeRepo("copy");
      try {
        clone.git("remote", "add", "origin", "git@github.com:WallyThePenguin/ReverseEngineer.git");
        expect(await run("code.add", { path: clone.dir })).toMatchObject({ code: "invalid_input" });
        const name = JSON.parse(readFileSync(join(NOOK_ROOT, "package.json"), "utf8")).name;
        copy.write("package.json", JSON.stringify({ name }));
        mkdirSync(join(copy.dir, "packages", "kernel"), { recursive: true });
        expect(await run("code.add", { path: copy.dir })).toMatchObject({ code: "invalid_input" });
      } finally {
        clone.destroy();
        copy.destroy();
      }
    },
    SLOW,
  );

  it(
    "refuses a folder that isn't a repo, one given in part, a drive's top, and keys",
    async () => {
      for (const path of [repo.root, "demo", "\\\\server\\share\\repo", join(repo.dir, "src")]) {
        expect(await run("code.add", { path }), path).toMatchObject({ code: "invalid_input" });
      }
      const top = process.platform === "win32" ? "C:\\" : "/";
      expect(await run("code.add", { path: top })).toMatchObject({ code: "invalid_input" });
      // A repo of your SSH keys is still keys.
      const keys = makeRepo(".ssh");
      try {
        const res = await run("code.add", { path: keys.dir });
        expect(res).toMatchObject({
          code: "invalid_input",
          message: expect.stringContaining("system"),
        });
      } finally {
        keys.destroy();
      }
    },
    SLOW,
  );

  it("is only yours: Pip can't add or remove a repo", async () => {
    expect((await run("code.add", { path: repo.dir }, pip)).status).toBe("denied");
    expect((await run("code.remove", { path: repo.dir }, pip)).status).toBe("denied");
  });
});

describe("what Pip may name", () => {
  it("refuses a ref that starts with -, or reads as a range or a path", async () => {
    for (const ref of ["--output=x", "-p", "HEAD..main", "HEAD:README.md", "a b"]) {
      const res = await run("code.log", { repo: "demo", ref }, pip);
      expect(res, ref).toMatchObject({ status: "error", code: "invalid_input" });
    }
    const diff = await run("code.diff", { repo: "demo", from: "--no-index" }, pip);
    expect(diff).toMatchObject({ code: "invalid_input" });
    expect(await run("code.log", { repo: "demo", ref: "nope" }, pip)).toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a path that leaves the repo, or names git's own folder", async () => {
    writeFileSync(join(repo.root, "outside.txt"), "not in the repo");
    const paths = [
      "../outside.txt",
      "src/../../outside.txt",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
    ];
    for (const path of [...paths, "-n", ".git/config", "src/app.ts:stream", "README.md."]) {
      const res = await run("code.read", { repo: "demo", path }, pip);
      expect(res, path).toMatchObject({ status: "error", code: "invalid_input" });
    }
    const blame = await run("code.blame", { repo: "demo", path: "../outside.txt" }, pip);
    expect(blame).toMatchObject({ code: "invalid_input" });
  });

  it("never shows a file that may hold secrets", async () => {
    for (const ref of [undefined, "HEAD"]) {
      const read = await run("code.read", { repo: "demo", path: ".env", ref }, pip);
      expect(read).toMatchObject({ status: "error", code: "forbidden" });
      expect(JSON.stringify(read)).toContain("secrets");
    }
    expect(await run("code.read", { repo: "demo", path: ".ENV" }, pip)).toMatchObject({
      code: "forbidden",
    });
    expect(await run("code.blame", { repo: "demo", path: ".env" }, pip)).toMatchObject({
      code: "forbidden",
    });
    const diff = await run("code.diff", { repo: "demo", commit: "HEAD" }, pip);
    expect(diff).toMatchObject({ status: "ok", result: { hidden: [".env"] } });
    const search = await run("code.search", { repo: "demo", text: "needle" }, pip);
    expect(search.status === "ok" && search.result).not.toHaveProperty("hidden");
    for (const res of [diff, search]) expect(JSON.stringify(res)).not.toContain(SECRET);
  });

  it("gives no sign a file with secrets matched a search: no hit, no count", async () => {
    const nothing = await run("code.search", { repo: "demo", text: "zz-not-anywhere" }, pip);
    expect(nothing).toMatchObject({ status: "ok", result: { hits: [], more: false } });
    for (const ref of [undefined, "HEAD", repo.first])
      for (const text of [SECRET, "TOKEN=", "needle-s"]) {
        const res = await run("code.search", { repo: "demo", text, ref, ignoreCase: true }, pip);
        expect(res, `${text} ${ref}`).toEqual(nothing);
      }
  });

  it("knows the usual names of files with secrets, in any case", () => {
    const secret = [".env", ".env.local", "prod.env", "certs/server.pem", "tls.KEY", "id_rsa"];
    secret.push("id_ed25519.pub", "credentials.json", ".git-credentials", "a/.ssh/config");
    secret.push(".npmrc", "secrets.yaml", "keystore.p12", "SRC\\.ENV", "secrets.ts");
    secret.push("terraform.tfstate", "infra/terraform.tfstate.backup", "prod.tfvars");
    secret.push(".docker/config.json", "home/.kube/config", ".config/gh/hosts.yml");
    secret.push(".yarnrc.yml", ".pypirc", ".netrc", "_netrc", "key.gpg", "pub.asc", "AuthKey.p8");
    secret.push("a.pkcs12", "b.pfx", "vpn.ovpn", "app.keystore", "app.jks", "db.kdbx");
    secret.push("service-account-prod.json", "gcp-credentials.json", "Secrets.JSON");
    secret.push("appsettings.Production.json", "web/wp-config.php", "deploy/secret.yml");
    const plain = ["src/app.ts", "README.md", "keys.ts", "environment.ts", "docs", "credits.md"];
    plain.push("appsettings.json", "docker/config.json", "kube/config.ts", "src/secret-santa.ts");
    plain.push("main.tf", "src/asc.ts", "config.json", "env.ts");
    expect(secret.filter((p) => !isSecret(p))).toEqual([]);
    expect(plain.filter(isSecret)).toEqual([]);
  });
});

describe("git, run for Pip", () => {
  it(
    "never runs a program the repo's config names",
    async () => {
      const marker = join(repo.root, "ran.log").replaceAll("\\", "/");
      const evil = makeRepo("evil");
      try {
        evil.write(".gitattributes", "*.ts diff=conv\n*.md diff=conv\n");
        evil.commit("Attributes");
        evil.write("README.md", "# Changed\n");
        // Set last, so the fixture's own git doesn't run them.
        evil.git("config", "core.fsmonitor", `echo fsmonitor >> "${marker}"; exit 1;`);
        evil.git("config", "diff.external", `echo external >> "${marker}"; true`);
        evil.git("config", "diff.conv.textconv", `echo textconv >> "${marker}"; cat`);
        evil.git("config", "core.worktree", repo.dir);
        expect((await run("code.add", { path: evil.dir })).status).toBe("ok");
        const calls: [string, Record<string, unknown>][] = [
          ["code.repos", {}],
          ["code.log", { repo: "evil", path: "src" }],
          ["code.diff", { repo: "evil", commit: "HEAD~1" }],
          ["code.diff", { repo: "evil", from: evil.first }],
          ["code.blame", { repo: "evil", path: "src/app.ts", start: 1, end: 5 }],
          ["code.search", { repo: "evil", text: "needle" }],
          ["code.read", { repo: "evil", path: "README.md" }],
          ["code.read", { repo: "evil", path: "src/app.ts", ref: "HEAD" }],
          ["code.read", { repo: "evil" }],
        ];
        for (const [name, input] of calls) {
          const res = await run(name, input, pip);
          expect(res.status, `${name} ${JSON.stringify(res)}`).toBe("ok");
        }
        // Its work tree stays its own folder, whatever core.worktree says.
        const read = await run("code.read", { repo: "evil", path: "README.md" }, pip);
        expect(read).toMatchObject({ result: { text: "1\t# Changed" } });
        expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
      } finally {
        evil.destroy();
      }
    },
    SLOW,
  );

  it("caps what comes back", async () => {
    expect(
      (await run("code.read", { repo: "demo", path: "src/app.ts", lines: 401 }, pip)).status,
    ).toBe("error");
    const read = await run("code.read", { repo: "demo", path: "src/app.ts" }, pip);
    expect(read).toMatchObject({ result: { from: 1, to: 200, total: 300 } });
    repo.write("big.txt", "x".repeat(100).concat("\n").repeat(1500));
    const sha = repo.commit("A big file");
    try {
      const diff = await run("code.diff", { repo: "demo", commit: sha }, pip);
      expect(diff).toMatchObject({ status: "ok", result: { truncated: true } });
      const text = diff.status === "ok" ? String(diff.result.diff) : "";
      expect(text.length).toBeLessThan(DIFF_CHARS + 50);
      const search = await run("code.search", { repo: "demo", text: "xxx", limit: 5 }, pip);
      expect(search).toMatchObject({ result: { more: true } });
      expect(search.status === "ok" && search.result.hits).toHaveLength(5);
    } finally {
      repo.git("reset", "-q", "--hard", "HEAD~1");
    }
  });
});

describe("Pip reading code", () => {
  const reads = codeModule.actions.filter((a) => a.risk === "read");

  it("never waits for your yes, even after outside content or in background work", async () => {
    expect(reads.map((a) => a.name).sort()).toEqual([
      "code.blame",
      "code.diff",
      "code.log",
      "code.read",
      "code.repos",
      "code.search",
    ]);
    for (const def of reads as ActionDef[]) {
      for (const caller of [jarvisCaller("owner"), jarvisCaller("untrusted")])
        expect(decide(def, caller, false), def.name).toEqual({ kind: "allow" });
      expect(def.external, def.name).toBe(true);
    }
    await setSetting(t.tdb.db, "jarvis.backgroundReadOnly", true);
    const background = jarvisCaller("untrusted", { mode: "proactive" });
    for (const [name, input] of [
      ["code.log", { repo: "demo" }],
      ["code.read", { repo: "demo", path: "README.md" }],
      ["code.search", { repo: "demo", text: "needle" }],
    ] as const) {
      expect((await run(name, input, background)).status, name).toBe("ok");
    }
  });
});
