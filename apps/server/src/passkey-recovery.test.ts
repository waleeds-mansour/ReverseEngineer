// When you can't use any of your passkeys (D81): `hearth setup --recover` prints a code that adds
// one more at Hearth's own address and signs you in. Once, within 30 minutes, never the window's.
import { credential } from "@hearth/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecoveryCode, createSetupCode } from "./auth/passkeys.ts";
import { SoftAuthenticator } from "./testing/authenticator.ts";
import { type Options, passkeyRig, TS_NET } from "./testing/passkeys.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ origin: TS_NET });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await t.destroy();
});

const { browser, window, options, me, connect, firstPasskey } = passkeyRig(() => t);

type Codes = { setupCode?: string; recoveryCode?: string };

/** Adds a passkey at Hearth's own address with a code: the refusal, or the verify's answer. */
async function addWith(codes: Codes, passkey = new SoftAuthenticator(TS_NET)) {
  const res = await browser("/api/auth/register/options", { method: "POST", json: codes });
  if (res.status !== 200) return res;
  const opts = (await res.json()) as Options;
  return browser("/api/auth/register/verify", {
    method: "POST",
    json: { response: passkey.register(opts), label: "Phone", ...codes },
  });
}

const passkeys = () => t.kernel.db.select().from(credential);

/** Signed out, with your laptop's passkey made the usual way. */
async function lockedOut() {
  const laptop = await firstPasskey();
  t.cookies.clear();
  expect(await me(browser)).toMatchObject({ signedIn: false, needsSetup: false });
  return laptop;
}

describe("the recovery code", () => {
  it("adds a passkey and signs you in while another passkey exists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const laptop = await lockedOut();
    // As typed: lower case, with spaces around.
    const code = await createRecoveryCode(t.kernel.db);
    const phone = new SoftAuthenticator(TS_NET);
    expect((await addWith({ recoveryCode: ` ${code.toLowerCase()} ` }, phone)).status).toBe(200);
    expect(await me(browser)).toMatchObject({ signedIn: true });
    expect(warn).toHaveBeenCalledWith(
      '[auth] recovery code used: added the passkey "Phone" and signed in',
    );

    const list = (await (await browser("/api/auth/passkeys")).json()) as {
      passkeys: { label: string; window: boolean }[];
    };
    expect(list.passkeys.map((p) => [p.label, p.window])).toEqual([
      ["Laptop", false],
      ["Phone", false],
    ]);
    // Both sign in from now on.
    for (const passkey of [laptop, phone]) {
      t.cookies.clear();
      const opts = await options(browser("/api/auth/login/options", { method: "POST" }));
      const res = await browser("/api/auth/login/verify", {
        method: "POST",
        json: { response: passkey.login(opts) },
      });
      expect(res.status).toBe(200);
    }
  });

  it("works once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await lockedOut();
    const code = await createRecoveryCode(t.kernel.db);
    expect((await addWith({ recoveryCode: code })).status).toBe(200);

    t.cookies.clear();
    const again = await addWith({ recoveryCode: code });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toContain("hearth setup --recover");
    expect(await me(browser)).toMatchObject({ signedIn: false });
    expect(warn).toHaveBeenCalledWith(
      "[auth] recovery code refused: it's wrong, used or out of time",
    );
    expect(await passkeys()).toHaveLength(2);
  });

  it("adds one passkey when two pages race with it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await lockedOut();
    const recoveryCode = await createRecoveryCode(t.kernel.db);
    // Two sign-in pages, each with its own challenge, both let in with the code.
    const pages = [];
    for (const passkey of [new SoftAuthenticator(TS_NET), new SoftAuthenticator(TS_NET)]) {
      const opts = await options(
        browser("/api/auth/register/options", { method: "POST", json: { recoveryCode } }),
      );
      pages.push({ passkey, opts, challenge: t.cookies.get("hearth_challenge")! });
    }
    // Sent at once: each request takes its page's cookie as it's sent.
    const answers = pages.map(({ passkey, opts, challenge }) => {
      t.cookies.set("hearth_challenge", challenge);
      return browser("/api/auth/register/verify", {
        method: "POST",
        json: { response: passkey.register(opts), label: "Phone", recoveryCode },
      });
    });
    const statuses = (await Promise.all(answers)).map((r) => r.status).sort();
    expect(statuses[0]).toBe(200);
    expect([400, 403]).toContain(statuses[1]);
    expect(await passkeys()).toHaveLength(2);
  });

  it("expires after 30 minutes, and a new one replaces the last", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await lockedOut();
    const old = await createRecoveryCode(t.kernel.db, new Date(Date.now() - 31 * 60_000));
    expect((await addWith({ recoveryCode: old })).status).toBe(403);

    const first = await createRecoveryCode(t.kernel.db);
    const second = await createRecoveryCode(t.kernel.db);
    expect((await addWith({ recoveryCode: first })).status).toBe(403);
    expect((await addWith({ recoveryCode: second })).status).toBe(200);
    expect(await passkeys()).toHaveLength(2);
  });

  it("never adds the window's passkey, signed in or not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await firstPasskey();
    await connect();
    const recoveryCode = await createRecoveryCode(t.kernel.db);
    const atWindow = () =>
      window("/api/auth/register/options", { method: "POST", json: { recoveryCode } });
    expect((await atWindow()).status).toBe(403);
    t.cookies.clear();
    expect((await atWindow()).status).toBe(403);
    expect(await me()).toMatchObject({ localPasskey: false });

    // It's still there for Hearth's own address.
    expect((await addWith({ recoveryCode })).status).toBe(200);
    expect((await passkeys()).map((p) => p.rpId)).toEqual([null, null]);
  });
});

describe("the setup code", () => {
  it("still refuses once a passkey exists, and neither code stands in for the other", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await lockedOut();
    const setupCode = await createSetupCode(t.kernel.db);
    expect((await addWith({ setupCode })).status).toBe(403);

    const recoveryCode = await createRecoveryCode(t.kernel.db);
    expect((await addWith({ setupCode: recoveryCode })).status).toBe(403);
    expect((await addWith({ recoveryCode: setupCode })).status).toBe(403);
    expect(await passkeys()).toHaveLength(1);
    expect(await me(browser)).toMatchObject({ signedIn: false });
  });
});
