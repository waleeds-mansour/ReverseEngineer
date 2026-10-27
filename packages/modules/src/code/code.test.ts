// Pip reading a repo you added: which repos, their history, a commit's changes, blame, a search
// and the files, on a throwaway repo in the OS temp folder.
import { type Caller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALL_MODULES } from "../index.ts";
import { APP_LINES, type Fixture, makeRepo } from "./fixture.ts";

let t: TestKernel;
let repo: Fixture;
beforeAll(() => {
  repo = makeRepo();
});
afterAll(() => repo.destroy());
beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  await ok("code.add", { path: repo.dir });
});
afterEach(async () => {
  await t.destroy();
});

const pip = jarvisCaller("owner");

async function ok<T = Record<string, unknown>>(
  name: string,
  input: unknown,
  caller: Caller = ownerCaller(),
): Promise<T> {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

const short = (sha: string) => sha.slice(0, 12);

describe("the repos Pip can read", () => {
  it("lists each with its branch and last commit, and forgets one you remove", async () => {
    const listed = await ok<{ repos: Record<string, unknown>[] }>("code.repos", {}, pip);
    expect(listed.repos).toEqual([
      {
        name: "demo",
        path: repo.dir,
        branch: "main",
        head: expect.objectContaining({ sha: short(repo.second), subject: "Second commit" }),
        problem: null,
      },
    ]);
    // Adding it again changes nothing.
    expect(await ok("code.add", { path: repo.dir })).toMatchObject({ repos: [{ name: "demo" }] });
    await ok("code.remove", { path: repo.dir });
    expect(await ok("code.repos", {}, pip)).toMatchObject({ repos: [], note: expect.any(String) });
    const gone = await t.kernel.execute("code.log", { repo: "demo" }, pip);
    expect(gone).toMatchObject({ status: "error", code: "not_found" });
  });
});

describe("a repo's history", () => {
  it("lists commits newest first, by path and from a ref, capped", async () => {
    const log = await ok<{ commits: { sha: string; subject: string; author: string }[] }>(
      "code.log",
      { repo: "demo" },
      pip,
    );
    expect(log.commits.map((c) => c.subject)).toEqual(["Second commit", "First commit"]);
    expect(log.commits[0]).toMatchObject({ sha: short(repo.second), author: "Ann Lee" });
    const readme = await ok("code.log", { repo: "demo", path: "README.md" }, pip);
    expect(readme).toMatchObject({ commits: [{ subject: "First commit" }], more: false });
    expect(await ok("code.log", { repo: "demo", limit: 1 }, pip)).toMatchObject({
      commits: [{ subject: "Second commit" }],
      more: true,
    });
    expect(await ok("code.log", { repo: repo.dir, ref: "HEAD~1" }, pip)).toMatchObject({
      commits: [{ subject: "First commit" }],
    });
  });

  it("shows a commit's own changes, the first commit's too, and those between two refs", async () => {
    const d = await ok<{ diff: string; files: unknown[]; commit: Record<string, unknown> }>(
      "code.diff",
      { repo: "demo", commit: "HEAD" },
      pip,
    );
    expect(d.commit).toMatchObject({ sha: short(repo.second), subject: "Second commit" });
    expect(d.files).toContainEqual({ status: "M", path: "src/app.ts" });
    expect(d.diff).toContain("+export const changed = 2;");
    expect(d.diff).toContain("-export const v2 = 2;");
    const root = await ok<{ diff: string }>("code.diff", { repo: "demo", commit: repo.first }, pip);
    expect(root.diff).toContain("+Hello needle");
    const range = await ok<{ diff: string }>(
      "code.diff",
      { repo: "demo", from: "HEAD~1", path: "src" },
      pip,
    );
    expect(range.diff).toContain("+export const changed = 2;");
    expect(range.diff).not.toContain("README");
    const neither = await t.kernel.execute("code.diff", { repo: "demo" }, pip);
    expect(neither).toMatchObject({ status: "error", code: "invalid_input" });
  });

  it("says who last changed each line, and in which commit", async () => {
    const b = await ok<{ lines: Record<string, unknown>[]; subjects: Record<string, string> }>(
      "code.blame",
      { repo: "demo", path: "src/app.ts", start: 1, end: 3 },
      pip,
    );
    expect(b.lines).toEqual([
      expect.objectContaining({ line: 1, sha: short(repo.first), text: "export const v1 = 1;" }),
      expect.objectContaining({ line: 2, sha: short(repo.second), author: "Ann Lee" }),
      expect.objectContaining({ line: 3, sha: short(repo.first) }),
    ]);
    expect(b.subjects[short(repo.second)]).toBe("Second commit");
    const old = await ok<{ lines: { sha: string }[] }>(
      "code.blame",
      { repo: "demo", path: "src/app.ts", start: 2, end: 2, ref: repo.first },
      pip,
    );
    expect(old.lines[0]!.sha).toBe(short(repo.first));
  });
});

describe("a repo's files", () => {
  it("finds exact text in the files git tracks, now or as of a commit", async () => {
    const s = await ok<{ hits: { path: string; line: number }[] }>(
      "code.search",
      { repo: "demo", text: "needle" },
      pip,
    );
    // Not the ignored file, nor the one not yet committed: only what git tracks.
    expect(s.hits.map((h) => `${h.path}:${h.line}`).sort()).toEqual([
      "README.md:2",
      "src/app.ts:7",
    ]);
    const under = await ok(
      "code.search",
      { repo: "demo", text: "NEEDLE", ignoreCase: true, path: "src" },
      pip,
    );
    expect(under).toMatchObject({ hits: [{ path: "src/app.ts", line: 7 }] });
    const then = await ok("code.search", { repo: "demo", text: "v2 = 2", ref: repo.first }, pip);
    expect(then).toMatchObject({ hits: [{ path: "src/app.ts", line: 2 }] });
    expect(await ok("code.search", { repo: "demo", text: "v2 = 2" }, pip)).toMatchObject({
      hits: [],
    });
  });

  it("reads a file's numbered lines, from the working tree or a commit", async () => {
    const r = await ok<{ text: string; total: number; more: string }>(
      "code.read",
      { repo: "demo", path: "src/app.ts", start: 2, lines: 2 },
      pip,
    );
    expect(r.text).toBe("2\texport const changed = 2;\n3\texport const v3 = 3;");
    expect(r.total).toBe(APP_LINES);
    expect(r.more).toContain("start: 4");
    const old = await ok<{ text: string }>(
      "code.read",
      { repo: "demo", path: "src/app.ts", ref: "HEAD~1", start: 2, lines: 1 },
      pip,
    );
    expect(old.text).toBe("2\texport const v2 = 2;");
    // Not committed yet, but git would add it: readable. Ignored: not.
    expect(await ok("code.read", { repo: "demo", path: "notes/new.md" }, pip)).toMatchObject({
      text: "1\tnot yet committed needle",
    });
    const ignored = await t.kernel.execute("code.read", { repo: "demo", path: "local.txt" }, pip);
    expect(ignored).toMatchObject({ status: "error", code: "not_found" });
  });

  it("lists a folder's contents, now or as of a commit", async () => {
    const top = await ok<{ entries: string[] }>("code.read", { repo: "demo" }, pip);
    expect(top.entries).toEqual(
      expect.arrayContaining(["README.md", "src/", "notes/", ".gitignore"]),
    );
    expect(top.entries).not.toContain("local.txt");
    expect(await ok("code.read", { repo: "demo", path: "src" }, pip)).toMatchObject({
      entries: ["app.ts"],
    });
    const then = await ok<{ entries: string[] }>(
      "code.read",
      { repo: "demo", ref: repo.first },
      pip,
    );
    expect(then.entries).not.toContain("notes/");
    expect(await ok("code.read", { repo: "demo", path: "src", ref: "main" }, pip)).toMatchObject({
      entries: ["app.ts"],
    });
  });
});
