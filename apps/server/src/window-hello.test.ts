// The window on this PC signs in with this PC's Windows Hello key, through the desktop app (D80):
// the key is sent once, with the ticket connecting gave, and each sign-in is Windows Hello signing
// a fresh challenge. The app's token alone never becomes a session (D53). Windows Hello is played
// here by an RSA key, as it makes them.
import { constants, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { PRINCIPAL } from "@hearth/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { unpairDevice } from "./auth/devices.ts";
import { SESSION_COOKIE } from "./auth/middleware.ts";
import { createSession } from "./auth/tokens.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

const TS_NET = "https://pc.example.ts.net";

let t: TestServer;
afterEach(async () => {
  vi.restoreAllMocks();
  await t.destroy();
});

async function serve() {
  t = await createTestServer({ origin: TS_NET });
  const token = await createSession(t.kernel.db, {
    principal: PRINCIPAL.owner,
    kind: "browser",
    label: "test browser",
    ttlDays: 1,
  });
  t.cookies.set(SESSION_COOKIE, token);
}

/** A Windows Hello key: RSA, 2048 bits, its public half as SubjectPublicKeyInfo in base64. */
function helloKey(bits = 2048) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { spki, privateKey };
}
const signed = (key: KeyObject, challenge: string) =>
  sign("sha256", Buffer.from(challenge), key).toString("base64");

/** The desktop app: its token, straight to Hearth's address on this PC. */
const fromApp = (path: string, token: string, json: unknown = {}) =>
  t.api(`/api/auth/desktop/${path}`, token, {
    method: "POST",
    json,
    from: "127.0.0.1",
    headers: { host: "localhost:4400" },
  });

/** Connecting this PC, as the hand-off does: the app's token, its window's code and a ticket. */
async function connect() {
  const started = await t.browser("/api/auth/desktop/handoff", { method: "POST" });
  const { nonce } = (await started.json()) as { nonce: string };
  const res = await t.server.app.request("/api/auth/desktop/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string; code: string; enroll: string };
}

async function enrolled() {
  const connected = await connect();
  const key = helloKey();
  const res = await fromApp("hello/enroll", connected.token, {
    ticket: connected.enroll,
    publicKey: key.spki,
  });
  expect(res.status).toBe(200);
  return { ...connected, key };
}

async function challenge(token: string) {
  const res = await fromApp("hello/challenge", token);
  expect(res.status).toBe(200);
  return ((await res.json()) as { challenge: string }).challenge;
}

const windowHello = async () =>
  ((await (await t.browser("/api/auth/me")).json()) as { windowHello: boolean }).windowHello;

describe("signing the window in with Windows Hello", () => {
  it("takes the key once connected, then trades a signed challenge for the window's code", async () => {
    await serve();
    expect(await windowHello()).toBe(false);
    const { token, key } = await enrolled();
    expect(await windowHello()).toBe(true);

    const c = await challenge(token);
    const res = await fromApp("hello/verify", token, {
      challenge: c,
      signature: signed(key.privateKey, c),
    });
    expect(res.status).toBe(200);
    const { code } = (await res.json()) as { code: string };

    // The window trades it as it trades a hand-off's: its one session, then Today.
    const opened = await t.server.app.request(`/api/auth/desktop/window?code=${code}`, {
      headers: { host: "localhost:4400" },
    });
    expect(opened.status).toBe(302);
    expect(opened.headers.get("location")).toBe("/today");
    const cookie = opened.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
    const me = await t.server.app.request("/api/auth/me", {
      headers: { cookie: cookie!.split(";")[0]! },
    });
    expect(await me.json()).toMatchObject({ signedIn: true, kind: "owner" });
  });

  it("never signs in with the token alone: another key, another challenge, or one used", async () => {
    await serve();
    const { token, key } = await enrolled();
    const other = helloKey();
    const verify = (challenge: string, signature: string) =>
      fromApp("hello/verify", token, { challenge, signature });

    const c1 = await challenge(token);
    expect((await verify(c1, signed(other.privateKey, c1))).status).toBe(401);
    expect((await verify(c1, signed(key.privateKey, c1))).status).toBe(410);

    const c2 = await challenge(token);
    const c3 = await challenge(token);
    expect((await verify(c2, signed(key.privateKey, c3))).status).toBe(401);
    expect((await verify(c3, "not a signature")).status).toBe(401);
    const made = "x".repeat(43);
    expect((await verify(made, signed(key.privateKey, made))).status).toBe(410);
  });

  it("takes a PSS signature too, should a Windows sign that way", async () => {
    await serve();
    const { token, key } = await enrolled();
    const c = await challenge(token);
    const signature = sign("sha256", Buffer.from(c), {
      key: key.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64");
    expect((await fromApp("hello/verify", token, { challenge: c, signature })).status).toBe(200);
  });

  it("lets challenges run out after five minutes", async () => {
    await serve();
    const { token, key } = await enrolled();
    const c = await challenge(token);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1_000);
    const res = await fromApp("hello/verify", token, {
      challenge: c,
      signature: signed(key.privateKey, c),
    });
    expect(res.status).toBe(410);
  });

  it("is only for the app's token, straight from this PC", async () => {
    await serve();
    const { token, key } = await enrolled();
    const c = await challenge(token);
    const json = { challenge: c, signature: signed(key.privateKey, c) };

    // Through Tailscale Serve, or from another machine.
    const viaServe = await t.api("/api/auth/desktop/hello/verify", token, {
      method: "POST",
      json,
      from: "127.0.0.1",
      headers: { host: "pc.example.ts.net", "x-forwarded-for": "100.64.0.7" },
    });
    expect(viaServe.status).toBe(403);
    const remote = await t.api("/api/auth/desktop/hello/verify", token, {
      method: "POST",
      json,
      from: "100.64.0.7",
      headers: { host: "localhost:4400" },
    });
    expect(remote.status).toBe(403);
    // Nor a browser signed in as you: the key is the window's alone.
    const browser = await t.browser("/api/auth/desktop/hello/challenge", {
      method: "POST",
      from: "127.0.0.1",
      headers: { host: "localhost:4400" },
    });
    expect(browser.status).toBe(403);
    // The challenge wasn't spent by any of those.
    expect((await fromApp("hello/verify", token, json)).status).toBe(200);
  });

  it("takes a key only with the ticket, once, and only Windows Hello's kind", async () => {
    await serve();
    const { token, enroll } = await connect();
    const enrol = (ticket: string, publicKey: string) =>
      fromApp("hello/enroll", token, { ticket, publicKey });

    expect((await enrol(enroll, helloKey(1024).spki)).status).toBe(400);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .publicKey.export({ type: "spki", format: "der" })
      .toString("base64");
    expect((await enrol(enroll, ec)).status).toBe(400);
    expect((await enrol(enroll, "not a key")).status).toBe(400);
    expect((await enrol("x".repeat(43), helloKey().spki)).status).toBe(410);

    expect((await enrol(enroll, helloKey().spki)).status).toBe(200);
    expect((await enrol(enroll, helloKey().spki)).status).toBe(410);
  });

  it("forgets the key when the app is connected again or disconnected", async () => {
    await serve();
    const first = await enrolled();
    const again = await connect();
    expect(await windowHello()).toBe(false);
    expect((await fromApp("hello/challenge", again.token)).status).toBe(409);

    const key = helloKey();
    await fromApp("hello/enroll", again.token, { ticket: again.enroll, publicKey: key.spki });
    expect(await windowHello()).toBe(true);
    // The last pairing's token is gone with it.
    expect((await fromApp("hello/challenge", first.token)).status).toBe(401);

    await unpairDevice(t.kernel.db, "desktop");
    expect(await windowHello()).toBe(false);
    expect((await fromApp("hello/challenge", again.token)).status).toBe(401);
  });
});
