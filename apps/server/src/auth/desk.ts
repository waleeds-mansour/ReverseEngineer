// The desk (D84): the desktop app's inbox, where you approve what Pip asks, answer its questions
// and clear finished work from the keyboard. The app's token alone can do none of that (D42).
// Once a sitting, the app asks Windows Hello to sign a fresh challenge with this PC's own key
// (D80, hello.ts). The signature opens a desk for that token and hands the app a secret of its
// own, kept only in its memory: every desk request carries it, so a program that reads the token
// off the disk (Pip has commands on this PC, D64) still can't use the desk. It shuts after 2 hours
// without a desk action, after 8 hours whatever happens, and when the app locks it as Windows
// locks or sleeps.
//
// Open desks live only in this process's memory, by the token's hash, with only the secret's
// hash: a restart forgets them, which only means Windows Hello asks again. Pairing again or
// disconnecting revokes the token, so its desk is of no more use even before it runs out.
import { createHash, randomBytes } from "node:crypto";
import type { Caller } from "@hearth/kernel";
import type { Context } from "hono";
import type { AppEnv } from "../env.ts";
import { directFromThisPc } from "../routes/health.ts";
import { HELLO_TTL_MS, SingleUse } from "./handoff.ts";
import { hashToken, safeEqual } from "./tokens.ts";

/** The longest a desk stays open: a working day, then Windows Hello asks again. */
export const DESK_MS = 8 * 3_600_000;
/** A desk nobody has used for this long shuts: the owner has likely walked away. */
export const DESK_IDLE_MS = 2 * 3_600_000;
/** The header every desk request carries the desk's secret in. */
export const DESK_HEADER = "x-hearth-desk";

export interface DeskTimes {
  /** When it shuts whatever happens. */
  until: Date;
  /** When it shuts unless a desk action comes first. */
  idleUntil: Date;
}

interface OpenDesk {
  secretHash: string;
  until: number;
  idleUntil: number;
}

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest("base64url");

export class Desks {
  /** Each open desk, by its token's hash. */
  private readonly open = new Map<string, OpenDesk>();
  /** How many times each token's desk was locked: a challenge from before a lock opens nothing. */
  private readonly locks = new Map<string, number>();
  /** As the window's sign-in challenges are (D80), and kept apart from them. */
  private readonly challenges: SingleUse;

  constructor(now: () => number = () => Date.now()) {
    this.challenges = new SingleUse(now, HELLO_TTL_MS);
  }

  /** A challenge for Windows Hello to sign: good once, for five minutes, for this token only. */
  challenge(token: string): string {
    const key = hashToken(token);
    return this.challenges.issue(`${key}#${this.locks.get(key) ?? 0}`);
  }

  /**
   * Uses up the challenge. When it was still good and this token's, the locks counted when it was
   * issued, for unlock to check; otherwise null.
   */
  takeChallenge(challenge: unknown, token: string): number | null {
    const issued = this.challenges.take(challenge);
    const at = issued?.lastIndexOf("#") ?? -1;
    if (!issued || at < 0 || issued.slice(0, at) !== hashToken(token)) return null;
    return Number(issued.slice(at + 1));
  }

  /**
   * Opens the token's desk with a fresh secret, unless it was locked since the challenge was
   * issued (`locks`, from takeChallenge): Windows locking while Windows Hello was asked, or while
   * its key was read, wins. Unlocking again starts both clocks again and replaces the secret.
   */
  unlock(token: string, now: Date, locks: number): (DeskTimes & { secret: string }) | null {
    const key = hashToken(token);
    if ((this.locks.get(key) ?? 0) !== locks) return null;
    const at = now.getTime();
    for (const [k, d] of this.open) if (at >= d.until || at >= d.idleUntil) this.open.delete(k);
    const secret = randomBytes(32).toString("base64url");
    const desk = {
      secretHash: hashSecret(secret),
      until: at + DESK_MS,
      idleUntil: at + DESK_IDLE_MS,
    };
    this.open.set(key, desk);
    return { secret, until: new Date(desk.until), idleUntil: new Date(desk.idleUntil) };
  }

  /** Shuts the token's desk, and fences off every challenge issued before now. */
  lock(token: string): void {
    const key = hashToken(token);
    this.open.delete(key);
    this.locks.set(key, (this.locks.get(key) ?? 0) + 1);
  }

  /**
   * The desk's times when it's open and `secret` is its own, compared in constant time; null
   * otherwise. `use`: a desk action, which keeps it from shutting for another 2 hours, to the cap.
   */
  check(token: string, secret: unknown, now: Date, use = false): DeskTimes | null {
    const key = hashToken(token);
    const desk = this.open.get(key);
    if (!desk || typeof secret !== "string" || secret.length > 128) return null;
    const at = now.getTime();
    if (at >= desk.until || at >= desk.idleUntil) {
      this.open.delete(key);
      return null;
    }
    if (!safeEqual(desk.secretHash, hashSecret(secret))) return null;
    if (use) desk.idleUntil = Math.min(at + DESK_IDLE_MS, desk.until);
    return { until: new Date(desk.until), idleUntil: new Date(desk.idleUntil) };
  }
}

/** The one this server uses; tests can make their own. */
export const desks = new Desks();

/**
 * The caller the sign-in check hands on, with `desk` set while the desktop app's desk is open.
 * This is how "the desk is open" reaches the desk's actions: the check already knows the token,
 * and the kernel hands the caller to every action as `ctx.caller`, so the actions need nothing
 * from HTTP. Only a device's token, with the desk's secret, straight from this PC through no
 * proxy: a token that leaked, to this PC or another, can't use a desk the owner opened here. A
 * desk action keeps the desk from going idle.
 */
export function withDesk(c: Context<AppEnv>, token: string, caller: Caller): Caller {
  if (caller.via !== "device" || !directFromThisPc(c)) return caller;
  const use = c.req.method === "POST" && c.req.path.startsWith("/api/actions/desk.");
  const now = c.get("deps").kernel.clock.now();
  const open = desks.check(token, c.req.header(DESK_HEADER), now, use) !== null;
  return open ? { ...caller, desk: true } : caller;
}
