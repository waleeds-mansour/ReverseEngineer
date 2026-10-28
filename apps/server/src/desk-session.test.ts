// The desk (D84): Windows Hello opens the desktop app's inbox for a sitting: 2 hours from the last
// desk action, 8 at most, and Windows locking closes it. Only the app itself opens it (its token,
// straight from this PC, a fresh challenge signed by this PC's Windows Hello key, D80), and only
// the desk's secret, kept in the app's memory, uses it.
import { PRINCIPAL } from "@hearth/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desks } from "./auth/desk.ts";
import { DEVICE_SCOPES, pairDevice, unpairDevice } from "./auth/devices.ts";
import { saveHelloKey } from "./auth/hello.ts";
import { SESSION_COOKIE } from "./auth/middleware.ts";
import { createSession } from "./auth/tokens.ts";
import { type AppInit, type DeskApp, deskApp, helloKey, signed } from "./testing/desk.ts";

const HOUR = 3_600_000;

let d: DeskApp;
afterEach(async () => {
  vi.restoreAllMocks();
  await d.t.destroy();
});

const unlockWith = (challenge: string, signature: string) =>
  d.fromApp("/api/desktop/desk/unlock", { json: { challenge, signature } });
const desk = async (init: AppInit = {}) =>
  (await (await d.fromApp("/api/desktop/desk", { method: "GET", ...init })).json()) as {
    open: boolean;
    until: string | null;
    idleUntil: string | null;
  };

describe("opening the desk", () => {
  it("opens once Windows Hello signs, with a secret only the app holds, and locking closes it", async () => {
    d = await deskApp();
    expect(await desk()).toEqual({ open: false, until: null, idleUntil: null });
    const opened = await d.unlock();
    const now = d.t.clock.now().getTime();
    expect(opened).toEqual({
      secret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      until: new Date(now + 8 * HOUR).toISOString(),
      idleUntil: new Date(now + 2 * HOUR).toISOString(),
    });
    expect(await desk()).toEqual({ open: true, until: opened.until, idleUntil: opened.idleUntil });
    expect((await d.act("desk.list")).status).toBe(200);

    // Windows locked: the desk shuts, and the actions refuse again.
    expect((await d.fromApp("/api/desktop/desk/lock")).status).toBe(200);
    expect(await d.isOpen()).toBe(false);
    expect((await d.act("desk.list")).status).toBe(403);
  });

  it("gives a token without the desk's secret nothing, even while it's open", async () => {
    d = await deskApp();
    const { secret } = await d.unlock();
    const wrong = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    for (const tried of [null, wrong, "", "x".repeat(500)]) {
      const r = await d.act("desk.list", {}, { secret: tried });
      expect([tried, r.status]).toEqual([tried, 403]);
      expect((await desk({ secret: tried })).open).toBe(false);
    }
    // Unlocking again replaces the secret: the old one is no good.
    await d.unlock();
    expect((await d.act("desk.list", {}, { secret })).status).toBe(403);
    expect((await d.act("desk.list")).status).toBe(200);
  });

  it("refuses another key's signature, a used challenge, one run out and another token's", async () => {
    d = await deskApp();
    const other = helloKey();
    const c1 = await d.challenge();
    expect((await unlockWith(c1, signed(other.privateKey, c1))).status).toBe(401);
    // Taken by that try: the right signature can't use it now.
    expect((await unlockWith(c1, signed(d.key.privateKey, c1))).status).toBe(410);
    const made = "x".repeat(43);
    expect((await unlockWith(made, signed(d.key.privateKey, made))).status).toBe(410);

    const c2 = await d.challenge();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1_000);
    expect((await unlockWith(c2, signed(d.key.privateKey, c2))).status).toBe(410);
    vi.restoreAllMocks();

    // A challenge is good only for the token that asked for it.
    const second = await createSession(d.t.kernel.db, {
      principal: PRINCIPAL.owner,
      kind: "api",
      label: "device:second",
      ttlDays: null,
      scopes: DEVICE_SCOPES.desktop!,
    });
    const theirs = await d.fromApp("/api/desktop/desk/challenge", { token: second });
    const { challenge: c3 } = (await theirs.json()) as { challenge: string };
    expect((await unlockWith(c3, signed(d.key.privateKey, c3))).status).toBe(410);
    expect(await d.isOpen()).toBe(false);
  });

  it("never opens with a challenge from before a lock, even one Windows Hello already signed", async () => {
    d = await deskApp();
    const c = await d.challenge();
    await d.fromApp("/api/desktop/desk/lock");
    expect((await unlockWith(c, signed(d.key.privateKey, c))).status).toBe(410);
    expect(await d.isOpen()).toBe(false);

    // The race itself: the challenge is taken, then Windows locks while the key is being read.
    const desks = new Desks();
    const token = "a-token-of-the-desktop-app";
    const locks = desks.takeChallenge(desks.challenge(token), token);
    expect(locks).toBe(0);
    desks.lock(token);
    expect(desks.unlock(token, new Date(), locks!)).toBeNull();
    const fresh = desks.takeChallenge(desks.challenge(token), token);
    expect(desks.unlock(token, new Date(), fresh!)).not.toBeNull();
  });

  it("shuts after 2 hours without a desk action, and after 8 hours whatever happens", async () => {
    d = await deskApp();
    await d.unlock();
    // Each desk action keeps it open another 2 hours; looking at whether it's open doesn't.
    for (let i = 0; i < 2; i++) {
      d.t.clock.advance(2 * HOUR - 60_000);
      expect(await d.isOpen()).toBe(true);
      expect((await d.act("desk.list")).status).toBe(200);
    }
    d.t.clock.advance(2 * HOUR - 60_000);
    expect(await d.isOpen()).toBe(true);
    d.t.clock.advance(2 * 60_000);
    expect(await d.isOpen()).toBe(false);
    expect((await d.act("desk.list")).status).toBe(403);

    // Kept busy, it still shuts at 8 hours.
    await d.unlock();
    for (let i = 0; i < 8; i++) {
      d.t.clock.advance(HOUR - 1_000);
      expect((await d.act("desk.list")).status).toBe(200);
    }
    d.t.clock.advance(9_000);
    expect((await d.act("desk.list")).status).toBe(403);
    expect(await d.isOpen()).toBe(false);
  });
});

describe("where the desk answers", () => {
  it("only straight from this PC: a proxy, another Host or another machine gets nothing", async () => {
    d = await deskApp();
    await d.unlock();
    const tries: AppInit[] = [
      { headers: { "x-forwarded-host": "pc.example.ts.net" } },
      { headers: { "x-forwarded-for": "100.64.0.9" } },
      { headers: { "tailscale-user-login": "owner@example.com" } },
      { headers: { host: "pc.example.ts.net" } },
      { from: "100.64.0.9" },
    ];
    for (const init of tries) {
      const listed = await d.act("desk.list", {}, init);
      expect([init, listed.status]).toEqual([init, 403]);
      for (const [path, method] of [
        ["/api/desktop/desk", "GET"],
        ["/api/desktop/desk/challenge", "POST"],
        ["/api/desktop/desk/lock", "POST"],
      ] as const)
        expect([path, init, (await d.fromApp(path, { ...init, method })).status]).toEqual([
          path,
          init,
          403,
        ]);
    }
    // Still open for the app itself: nothing above locked it.
    expect((await d.act("desk.list")).status).toBe(200);
  });

  it("never for a browser signed in as you", async () => {
    d = await deskApp();
    const browser = await createSession(d.t.kernel.db, {
      principal: PRINCIPAL.owner,
      kind: "browser",
      label: "test browser",
      ttlDays: 1,
    });
    d.t.cookies.set(SESSION_COOKIE, browser);
    const post = (path: string) => d.t.browser(path, { method: "POST", json: {} });
    expect((await post("/api/desktop/desk/challenge")).status).toBe(403);
    expect((await post("/api/actions/desk.list")).status).toBe(403);
  });

  it("is gone with the token: pairing again or disconnecting while it's open", async () => {
    d = await deskApp();
    const old = await d.unlock();
    const paired = await pairDevice(d.t.kernel.db, "desktop");
    expect((await d.act("desk.list")).status).toBe(401);
    // The new token has no desk, whatever secret it brings.
    expect((await d.act("desk.list", {}, { token: paired, secret: old.secret })).status).toBe(403);

    // Pairing again forgets the Windows Hello key too (D80): the app sends a new one.
    d.token = paired;
    await saveHelloKey(d.t.kernel.db, d.key.spki);
    await d.unlock();
    expect((await d.act("desk.list")).status).toBe(200);
    await unpairDevice(d.t.kernel.db, "desktop");
    expect((await d.act("desk.list")).status).toBe(401);
    expect((await d.fromApp("/api/desktop/desk", { method: "GET" })).status).toBe(401);
  });
});
