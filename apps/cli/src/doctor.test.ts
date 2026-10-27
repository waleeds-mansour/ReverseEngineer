import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Runner } from "./backup.ts";
import { checkBackupTools, checkChrome, checkClaudeLogin } from "./doctor.ts";

const schtasks =
  (code: number, stdout = ""): Runner =>
  async () => ({ code, stdout, stderr: "" });

describe("hearth doctor", () => {
  it("tells a Claude login that a failed refresh emptied from one that still works", () => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-claude-"));
    const login = (oauth: unknown) => {
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }));
      return checkClaudeLogin({ CLAUDE_CONFIG_DIR: dir }, 1_000);
    };
    const empty = { accessToken: "", refreshToken: "", expiresAt: 0 };
    expect(login(empty)).toMatchObject({
      mark: "warn",
      detail: expect.stringContaining("signed out"),
    });
    expect(login({ ...empty, refreshToken: "r" }).mark).toBe("ok");
    expect(login({ ...empty, accessToken: "a", expiresAt: 2_000 }).mark).toBe("ok");
    expect(login({ ...empty, accessToken: "a", expiresAt: 500 }).mark).toBe("warn");
    // A shape it doesn't know isn't called signed out.
    expect(login(undefined).mark).toBe("ok");
    writeFileSync(join(dir, ".credentials.json"), "not json");
    expect(checkClaudeLogin({ CLAUDE_CONFIG_DIR: dir }).mark).toBe("ok");
    expect(checkClaudeLogin({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: dir }).detail).toBe(
      "Using ANTHROPIC_API_KEY",
    );
  });

  it("checks that Windows can open Chrome for Hearth's service", async () => {
    expect(await checkChrome({}, "win32", schtasks(0))).toMatchObject({
      mark: "ok",
      detail: 'Hearth opens it with the "Hearth Chrome" task',
    });
    expect((await checkChrome({}, "win32", schtasks(1))).mark).toBe("warn");
  });

  it("notices when the task's Chrome has moved", async () => {
    const xml = (path: string) =>
      [..."<Task><Actions><Exec><Command>", ...path, ..."</Command></Exec></Actions></Task>"].join(
        "\0",
      );
    const gone = await checkChrome({}, "win32", schtasks(0, xml("C:\\Old\\chrome.exe")));
    expect(gone).toMatchObject({ mark: "warn" });
    expect(gone.detail).toContain("isn't there anymore");
    const here = await checkChrome({}, "win32", schtasks(0, xml(process.execPath)));
    expect(here.mark).toBe("ok");
  });

  it("finds Chrome elsewhere, or says you open it yourself", async () => {
    expect((await checkChrome({ PATH: "/nowhere" }, "linux")).mark).toBe("warn");
    const off = await checkChrome({ HEARTH_CHROME_LAUNCH: "off" }, "linux");
    expect(off).toMatchObject({ mark: "ok" });
    const node = { HEARTH_CHROME_PATH: process.execPath };
    expect(await checkChrome(node, "linux")).toMatchObject({ mark: "ok" });
  });

  it("asks restic for its version the way restic understands", async () => {
    // Real restic exits non-zero on --version; everything else accepts it.
    const run: Runner = async (cmd, args) => ({
      code: cmd === "restic" && args[0] !== "version" ? 1 : 0,
      stdout: "",
      stderr: "",
    });
    const checks = await checkBackupTools(
      { HEARTH_BACKUP_REPOSITORY: "rclone:gdrive:hearth", RESTIC_PASSWORD: "x" },
      run,
    );
    expect(checks.map((c) => [c.name, c.mark])).toEqual([
      ["pg_dump", "ok"],
      ["restic", "ok"],
      ["rclone", "ok"],
    ]);
  });

  it("fails a restic too old to restore from", async () => {
    const version =
      (v: string): Runner =>
      async (cmd) => ({
        code: 0,
        stdout: cmd === "restic" ? `restic ${v} compiled with go1.22 on windows/amd64\n` : "",
        stderr: "",
      });
    const env = { HEARTH_BACKUP_REPOSITORY: "D:\\backups", RESTIC_PASSWORD: "x" };
    const old = await checkBackupTools(env, version("0.16.4"));
    expect(old.find((c) => c.name === "restic")).toMatchObject({
      mark: "fail",
      detail: expect.stringContaining("0.16.4 is too old"),
    });
    const now = await checkBackupTools(env, version("0.19.1"));
    expect(now.find((c) => c.name === "restic")?.mark).toBe("ok");
  });
});
