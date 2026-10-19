// Sign-in with passkeys. The first passkey is added with the setup code `hearth setup` prints;
// after that, new passkeys can only be added from a signed-in session, or with the recovery code
// `hearth setup --recover` prints when you can't use any of yours (D81). The desktop app's window
// signs in by hand-off from a signed-in browser (D53, /desktop/* below), with this PC's Windows
// Hello key through the app (D80, auth/hello.ts), or with a Windows Hello passkey of its own once
// you've added one there (D69, auth/relying-party.ts).

import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { DESKTOP_WINDOW, desktopPaired, pairDevice, revokeDesktopWindow } from "../auth/devices.ts";
import { type Handoffs, handoffs as sharedHandoffs } from "../auth/handoff.ts";
import { helloKey, readHelloKey, saveHelloKey, signedByHello } from "../auth/hello.ts";
import { SESSION_COOKIE, secureCookies } from "../auth/middleware.ts";
import {
  checkRecoveryCode,
  checkSetupCode,
  hasPasskey,
  listPasskeys,
  loginOptions,
  passkeysMade,
  registrationOptions,
  removePasskey,
  verifyLogin,
  verifyRegistration,
} from "../auth/passkeys.ts";
import { relyingPartyFor } from "../auth/relying-party.ts";
import { createSession, revokeToken } from "../auth/tokens.ts";
import type { AppEnv } from "../env.ts";
import { directFromThisPc } from "./health.ts";

const CHALLENGE_COOKIE = "hearth_challenge";
const SESSION_DAYS = 30;

const codes = {
  setupCode: z.string().max(40).optional(),
  recoveryCode: z.string().max(40).optional(),
};
const registerOptionsBody = z.object(codes);
const verifyBody = z.object({
  // The browser's WebAuthn response; SimpleWebAuthn checks its shape.
  response: z.record(z.string(), z.unknown()),
  label: z.string().max(100).optional(),
  ...codes,
});
type Codes = { setupCode?: string | undefined; recoveryCode?: string | undefined };

function setChallenge(c: Context<AppEnv>, id: string) {
  setCookie(c, CHALLENGE_COOKIE, id, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c),
    path: "/api/auth",
    maxAge: 300,
  });
}

function takeChallengeCookie(c: Context<AppEnv>): string | null {
  const id = getCookie(c, CHALLENGE_COOKIE) ?? null;
  deleteCookie(c, CHALLENGE_COOKIE, { path: "/api/auth" });
  return id;
}

async function signIn(c: Context<AppEnv>, principal: string, label?: string) {
  const { kernel } = c.get("deps");
  const token = await createSession(kernel.db, {
    principal,
    kind: "browser",
    label: label ?? c.req.header("user-agent")?.slice(0, 120) ?? "browser",
    ttlDays: SESSION_DAYS,
  });
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Strict",
    secure: secureCookies(c),
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

/** Each use of the recovery code, kept in the server's log (D81). */
const recoveryLog = (what: string) => console.warn(`[auth] recovery code ${what}`);

/**
 * How you may add a passkey, if at all: signed in; with the setup code while none exists yet; or
 * with the recovery code when you can't use any of yours (D81). The window's own only signed in,
 * never with a code, and never as the first: that one is for Hearth's own address, even when
 * development login has signed you in without any (D69).
 */
async function mayRegister(
  c: Context<AppEnv>,
  codes: Codes,
  local: boolean,
): Promise<"signed in" | "setup" | "recovery" | null> {
  const { kernel } = c.get("deps");
  const owner = c.get("caller")?.kind === "owner";
  if (local && codes.recoveryCode !== undefined) {
    recoveryLog("refused: it adds passkeys only at Hearth's own address, not the window's");
    return null;
  }
  if (local) return owner && (await hasPasskey(kernel.db)) ? "signed in" : null;
  if (owner) return "signed in";
  if (codes.recoveryCode !== undefined) {
    if (await checkRecoveryCode(kernel.db, codes.recoveryCode)) return "recovery";
    recoveryLog("refused: it's wrong, used or out of time");
    return null;
  }
  if (await hasPasskey(kernel.db)) return null;
  return codes.setupCode && (await checkSetupCode(kernel.db, codes.setupCode)) ? "setup" : null;
}

const refusal = (codes: Codes) =>
  codes.recoveryCode !== undefined
    ? "That recovery code didn't work. Each works once, for 30 minutes: run `hearth setup --recover` on the PC for a new one."
    : "Sign in, or use the setup code from `hearth setup`.";

const NOT_CONNECTED = "This PC's Nook window isn't connected. Connect it from your browser.";

const redeemBody = z.object({ nonce: z.string().min(16).max(128) });
const enrollBody = z.object({ ticket: z.string().max(128), publicKey: z.string().max(2048) });
const helloBody = z.object({ challenge: z.string().max(128), signature: z.string().max(1024) });

/** The desktop app itself: its device token, straight from this PC, through no proxy (D80). */
const fromTheApp = (c: Context<AppEnv>) =>
  c.get("caller")?.via === "device" && !c.get("viaCookie") && directFromThisPc(c);
const NOT_THE_APP = "Only Nook's desktop app on this PC can do that.";

const RUN_OUT_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Connect again</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;line-height:1.5}</style>
</head><body><h1>That sign-in link has run out</h1>
<p>In Nook in your browser, open Settings, then Desktop app, and choose
<b>Connect Nook on this PC</b> again.</p></body></html>`;

export function authRoutes(handoffs: Handoffs = sharedHandoffs) {
  const app = new Hono<AppEnv>();

  // The desktop app's sign-in hand-off (D53, auth/handoff.ts). Signed in in your browser, you
  // ask for a connect link. Only that: a device's token can't, so it can never become a session.
  app.post("/desktop/handoff", (c) => {
    const caller = c.get("caller");
    if (!c.get("viaCookie") || caller?.kind !== "owner" || caller.via !== "ui")
      return c.json({ error: "Sign in to Nook in your browser first." }, 403);
    const nonce = handoffs.nonces.issue(caller.principal);
    c.header("Cache-Control", "no-store");
    return c.json({ nonce, link: `hearth://connect?nonce=${nonce}`, expiresInSeconds: 60 });
  });

  // The app trades the nonce for its device token, a code for its window, and a ticket to send
  // its Windows Hello key with (D80). It's paired anew, so its token has today's scopes, and the
  // last pairing's key is forgotten.
  app.post("/desktop/redeem", async (c) => {
    const body = redeemBody.safeParse(await c.req.json().catch(() => null));
    const principal = body.success ? handoffs.nonces.take(body.data.nonce) : null;
    if (!principal) return c.json({ error: "That connect link has run out or was used." }, 410);
    const token = await pairDevice(c.get("deps").kernel.db, "desktop");
    c.header("Cache-Control", "no-store");
    return c.json({
      token,
      code: handoffs.codes.issue(principal),
      enroll: handoffs.enrolls.issue(principal),
    });
  });

  // The window's Windows Hello key (D80, auth/hello.ts): only with the ticket connecting gave.
  app.post("/desktop/hello/enroll", async (c) => {
    if (!fromTheApp(c)) return c.json({ error: NOT_THE_APP }, 403);
    const body = enrollBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success || !readHelloKey(body.data.publicKey))
      return c.json({ error: "That isn't a Windows Hello key." }, 400);
    if (!handoffs.enrolls.take(body.data.ticket))
      return c.json({ error: "Setting up Windows Hello ran out. Connect this PC again." }, 410);
    await saveHelloKey(c.get("deps").kernel.db, body.data.publicKey);
    return c.json({ ok: true });
  });

  // Signing the window in again: Windows Hello signs a fresh challenge with the window's key, and
  // the signature buys a code, as a hand-off does. The token alone gets no further than this.
  app.post("/desktop/hello/challenge", async (c) => {
    if (!fromTheApp(c)) return c.json({ error: NOT_THE_APP }, 403);
    if (!(await helloKey(c.get("deps").kernel.db)))
      return c.json({ error: "Windows Hello isn't set up for this window. Connect again." }, 409);
    c.header("Cache-Control", "no-store");
    return c.json({ challenge: handoffs.challenges.issue(c.get("caller")!.principal) });
  });

  app.post("/desktop/hello/verify", async (c) => {
    if (!fromTheApp(c)) return c.json({ error: NOT_THE_APP }, 403);
    const body = helloBody.safeParse(await c.req.json().catch(() => null));
    const principal = body.success ? handoffs.challenges.take(body.data.challenge) : null;
    const key = await helloKey(c.get("deps").kernel.db);
    if (!body.success || !principal || !key)
      return c.json({ error: "That sign-in ran out. Try again." }, 410);
    if (!signedByHello(key, body.data.challenge, body.data.signature)) {
      console.warn("[auth] window sign-in refused: not signed by its Windows Hello key");
      return c.json({ error: "Windows Hello's signature didn't match." }, 401);
    }
    c.header("Cache-Control", "no-store");
    return c.json({ code: handoffs.codes.issue(principal) });
  });

  // The app's window trades the code for an ordinary session, then opens Today. It has one
  // such session: connecting again signs the last one out, and so does disconnecting the app.
  app.get("/desktop/window", async (c) => {
    const principal = handoffs.codes.take(c.req.query("code"));
    c.header("Cache-Control", "no-store");
    if (!principal) return c.html(RUN_OUT_PAGE, 410);
    await revokeDesktopWindow(c.get("deps").kernel.db);
    await signIn(c, principal, DESKTOP_WINDOW);
    return c.redirect("/today", 302);
  });

  app.get("/me", async (c) => {
    const { kernel, config } = c.get("deps");
    const caller = c.get("caller");
    const made = await passkeysMade(kernel.db);
    return c.json({
      signedIn: !!caller,
      principal: caller?.principal ?? null,
      kind: caller?.kind ?? null,
      needsSetup: !made.own,
      // Where your passkeys work, and whether the window on this PC can sign in with its own: it
      // has one and the app is connected (D69). The address is public anyway: Google's sign-in
      // is sent back to it.
      origin: config.origin,
      localPasskey: made.window && (await desktopPaired(kernel.db)),
      // Whether the app can sign the window in with this PC's Windows Hello key (D80).
      windowHello: (await helloKey(kernel.db)) !== null,
    });
  });

  // Your passkeys, and the address each works at, for Settings.
  app.get("/passkeys", async (c) => {
    if (c.get("caller")?.kind !== "owner") return c.json({ error: "Sign in first." }, 401);
    const { kernel, config } = c.get("deps");
    return c.json({ passkeys: await listPasskeys(kernel.db), origin: config.origin });
  });

  // Removing one: it can't sign in after this. Sessions it already started stay signed in.
  app.delete("/passkeys/:id", async (c) => {
    if (c.get("caller")?.kind !== "owner") return c.json({ error: "Sign in first." }, 401);
    const { kernel, config } = c.get("deps");
    const removed = await removePasskey(kernel.db, c.req.param("id"));
    if (removed === "missing") return c.json({ error: "That passkey is already gone." }, 404);
    if (removed === "last")
      return c.json(
        {
          error: `It's your only passkey for ${new URL(config.origin).host}. Add another before you remove it.`,
        },
        409,
      );
    return c.json({ removed: true });
  });

  app.post("/register/options", async (c) => {
    const { kernel } = c.get("deps");
    const rp = relyingPartyFor(c);
    const body = registerOptionsBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success || !(await mayRegister(c, body.data, !!rp.local))) {
      return c.json({ error: refusal(body.data ?? {}) }, 403);
    }
    const { options, challengeId } = await registrationOptions(kernel.db, rp);
    setChallenge(c, challengeId);
    return c.json(options);
  });

  app.post("/register/verify", async (c) => {
    const { kernel } = c.get("deps");
    const rp = relyingPartyFor(c);
    const body = verifyBody.safeParse(await c.req.json().catch(() => null));
    const challengeId = takeChallengeCookie(c);
    if (!body.success || !challengeId) return c.json({ error: "Start again." }, 400);
    const way = await mayRegister(c, body.data, !!rp.local);
    if (!way) return c.json({ error: refusal(body.data) }, 403);
    const label = body.data.label ?? "Passkey";
    const recovery = way === "recovery" ? body.data.recoveryCode : undefined;
    const ok = await verifyRegistration(
      kernel.db,
      rp,
      challengeId,
      body.data.response as never,
      label,
      recovery,
    ).catch(() => false);
    if (!ok) return c.json({ error: "That passkey couldn't be verified." }, 400);
    if (way === "recovery")
      recoveryLog(`used: added the passkey ${JSON.stringify(label)} and signed in`);
    if (way !== "signed in") await signIn(c, "owner");
    return c.json({ ok: true });
  });

  app.post("/login/options", async (c) => {
    const { kernel } = c.get("deps");
    const rp = relyingPartyFor(c);
    if (rp.local && !(await desktopPaired(kernel.db))) return c.json({ error: NOT_CONNECTED }, 409);
    const made = await loginOptions(kernel.db, rp);
    if (!made)
      return c.json(
        {
          error: rp.local
            ? "This PC's Nook window has no passkey yet. Connect it from your browser."
            : "No passkey yet. Run `hearth setup`.",
        },
        409,
      );
    setChallenge(c, made.challengeId);
    return c.json(made.options);
  });

  app.post("/login/verify", async (c) => {
    const { kernel } = c.get("deps");
    const rp = relyingPartyFor(c);
    const body = verifyBody.safeParse(await c.req.json().catch(() => null));
    const challengeId = takeChallengeCookie(c);
    if (!body.success || !challengeId) return c.json({ error: "Start again." }, 400);
    // Disconnected since: the window's passkey has nothing to sign in as until you connect again.
    if (rp.local && !(await desktopPaired(kernel.db))) return c.json({ error: NOT_CONNECTED }, 409);
    const principal = await verifyLogin(
      kernel.db,
      rp,
      challengeId,
      body.data.response as never,
    ).catch(() => null);
    if (!principal) return c.json({ error: "That passkey didn't work." }, 401);
    if (rp.local) {
      // The window's passkey signs in only as the window: its one session, as a hand-off makes,
      // so connecting again replaces it and Disconnect signs it out (D53).
      await revokeDesktopWindow(kernel.db);
      await signIn(c, principal, DESKTOP_WINDOW);
    } else await signIn(c, principal);
    return c.json({ ok: true });
  });

  app.post("/logout", async (c) => {
    const { kernel } = c.get("deps");
    const token = c.get("token");
    if (token && c.get("viaCookie")) await revokeToken(kernel.db, token);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  return app;
}
