// GET /api/desktop/notify: what the desktop app shows as Windows notifications (D53), and what its
// dock shows. As `notify` events, the inbox items your phone is told about (push.ts decides which)
// and Hearth's health changing; as `status` events, what Pip is doing, how many things wait for
// your yes and Nook's health (deskLite), when the feed opens and whenever that reads differently.
// The desktop app's token may read it; nothing here can approve anything, a notification only
// opens a page, and a status is counts, states and a few words of label, never anyone's words.
// Each notification says its card's kind, so the desk knows which card came and how it sounds;
// Pip's questions and finished work come too, finished work quietly (D84).
//
// Below the feed: opening and closing the desk with Windows Hello (D84).
import { notification } from "@hearth/db";
import { type HearthEvent, latestSeq, readEventsAfter } from "@hearth/kernel";
import { DESK_LITE_KINDS, type DeskLite, deskLite } from "@hearth/modules";
import { inArray } from "drizzle-orm";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { DESK_HEADER, desks } from "../auth/desk.ts";
import { helloKey, signedByHello } from "../auth/hello.ts";
import { requireCaller } from "../auth/middleware.ts";
import { checkToken } from "../auth/tokens.ts";
import type { AppEnv, ServerDeps } from "../env.ts";
import { messageFor, PUSH_KINDS, type PushMessage, worthTelling } from "../push.ts";
import { fromTheApp, NOT_THE_APP } from "./auth.ts";

const KEEP_ALIVE_MS = 20_000;
/** A reconnect catches up on what it missed, but nothing older than this: it's news, not a log. */
const REPLAY_MS = 10 * 60_000;
const KINDS = [...new Set([...PUSH_KINDS, "system.health_changed", ...DESK_LITE_KINDS])];
/**
 * While Pip is on something, the status is read this often as well: a turn with no conversation
 * ends without an event, and the dock should still see it end within a couple of seconds.
 */
const WHILE_BUSY_MS = 2_000;
/** How long one read of the dock's status serves every feed on this server. */
const SHARE_MS = 1_000;

const unlockBody = z.object({ challenge: z.string().max(128), signature: z.string().max(1024) });
const SHUT = { open: false, until: null, idleUntil: null };

const NAMES: Record<string, string> = {
  worker: "Nook's worker",
  jarvis: "Pip",
  backup: "Backups",
  disk: "Disk space",
};

/** A health change worth a notification: trouble starting, or trouble ending. */
export function healthMessage(p: Record<string, unknown>, seq: number): PushMessage | null {
  const component = String(p.component ?? "");
  const name = NAMES[component] ?? component;
  const tag = `health:${component}:${seq}`;
  if (p.status === "ok") {
    if (p.previous !== "degraded" && p.previous !== "failing") return null;
    return { title: `${name}: working again`, body: "", url: "/settings", tag, kind: "health" };
  }
  return {
    title: p.status === "failing" ? `${name} isn't working` : `${name} needs a look`,
    body: "Open Nook's Settings to see what's wrong.",
    url: "/settings",
    tag,
    kind: "health",
  };
}

/** The notifications in a batch of events, in order. */
export async function messagesFor(
  db: ServerDeps["kernel"]["db"],
  events: HearthEvent[],
  now: number,
): Promise<{ seq: number; message: PushMessage }[]> {
  const fresh = events.filter((e) => now - e.at.getTime() <= REPLAY_MS);
  // An interrupt held for quiet hours has two events: only its delivery is worth one.
  const worth = fresh.filter((e) => PUSH_KINDS.includes(e.kind) && worthTelling(e.payload));
  const ids = worth.map((e) => String(e.payload.notificationId));
  const rows = ids.length
    ? await db.select().from(notification).where(inArray(notification.id, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: { seq: number; message: PushMessage }[] = [];
  for (const e of fresh) {
    if (e.kind === "system.health_changed") {
      const message = healthMessage(e.payload, e.seq);
      if (message) out.push({ seq: e.seq, message });
    } else if (worth.includes(e)) {
      const row = byId.get(String(e.payload.notificationId));
      if (row) out.push({ seq: e.seq, message: messageFor(row) });
    }
  }
  return out;
}

/**
 * Whether the token the feed was opened with still signs in. The feed outlives the request that
 * checked it, so disconnecting the app (or connecting it again, which replaces its token) has to
 * end it here, or a signed-out PC would go on being told about your inbox.
 */
export async function stillSignedIn(
  db: ServerDeps["kernel"]["db"],
  token: string | null,
): Promise<boolean> {
  // Development login on loopback has no token to sign out.
  if (!token) return true;
  // Listening isn't using: this mustn't keep a sign-in alive (D56).
  return (await checkToken(db, token, new Date(), { touch: false })).ok;
}

type Stream = Parameters<Parameters<typeof streamSSE>[1]>[0];

/** Where the dock's status is read from; a test can hold a read open here. */
export const statusReads = { deskLite };

const readings = new WeakMap<object, { seen: number; at: number; status: Promise<DeskLite> }>();

/**
 * The dock's status, one read shared by every feed on this server for SHARE_MS, so each PC's feed
 * doesn't add queries of its own. A read serves only a feed that has seen no event newer than the
 * ones the feed that began it had seen, so what an event changed is never answered by a read
 * begun before it.
 */
export function sharedStatus(deps: ServerDeps, seen: number): Promise<DeskLite> {
  const db = deps.kernel.db;
  const at = performance.now();
  const last = readings.get(db);
  if (last && last.seen >= seen && at - last.at < SHARE_MS) return last.status;
  const status = statusReads.deskLite(db, deps.kernel.clock.now());
  const reading = { seen, at, status };
  readings.set(db, reading);
  // A read that failed isn't shared with the next feed.
  status.catch(() => {
    if (readings.get(db) === reading) readings.delete(db);
  });
  return status;
}

/**
 * The dock's status on one feed: read when asked, after the events the feed has `seen`, and sent
 * only when it reads differently from the last one sent. One read at a time, so a late one never
 * overtakes a newer one; asked again while one is under way, it reads once more after it, however
 * many times it was asked. A status has no id: the app's place in the feed is its notifications'.
 */
export function dockStatus(
  deps: ServerDeps,
  token: string | null,
  stream: Stream,
  seen: () => number,
) {
  let said = "";
  let busy = false;
  let running: Promise<void> | null = null;
  let again = false;
  const once = async () => {
    if (stream.aborted) return;
    const status = await sharedStatus(deps, seen());
    busy = status.pip.state !== "idle";
    const data = JSON.stringify(status);
    if (data === said) return;
    // The feed outlives the request that checked its token (stillSignedIn).
    if (said && !(await stillSignedIn(deps.kernel.db, token))) return stream.abort();
    said = data;
    await stream.writeSSE({ event: "status", data });
  };
  const run = async () => {
    for (;;) {
      again = false;
      await once().catch(() => {});
      // Nothing is awaited between this look and letting go, so no ask falls between them.
      if (!again || stream.aborted) {
        running = null;
        return;
      }
    }
  };
  return {
    tell: (): Promise<void> => {
      if (running) again = true;
      else running = run();
      return running;
    },
    busy: () => busy,
    /** Once the read under way, if any, is done. */
    settled: (): Promise<void> => running ?? Promise.resolve(),
  };
}

export function desktopRoutes() {
  const app = new Hono<AppEnv>();
  app.get("/notify", requireCaller(["owner"]), (c) => {
    const deps = c.get("deps");
    const token = c.get("token");
    const header = c.req.header("last-event-id");
    const from = header ? Number(header) : Number.NaN;
    return streamSSE(c, async (stream) => {
      const latest = await latestSeq(deps.kernel.db);
      // Picks up after the last event this app saw, if it's one Hearth has; otherwise from now.
      let cursor = Number.isInteger(from) && from >= 0 && from <= latest ? from : latest;
      let pumping: Promise<void> | null = null;
      let again = false;
      const status = dockStatus(deps, token, stream, () => cursor);

      const pump = async () => {
        do {
          again = false;
          let moved = false;
          for (;;) {
            const events = await readEventsAfter(deps.kernel.db, cursor, {
              limit: 200,
              kinds: KINDS,
            });
            const now = deps.kernel.clock.now().getTime();
            const messages = await messagesFor(deps.kernel.db, events, now);
            if (messages.length && !(await stillSignedIn(deps.kernel.db, token))) {
              return stream.abort();
            }
            for (const { seq, message } of messages) {
              await stream.writeSSE({
                event: "notify",
                id: String(seq),
                data: JSON.stringify(message),
              });
            }
            if (events.some((e) => DESK_LITE_KINDS.includes(e.kind))) moved = true;
            if (events.length) cursor = events[events.length - 1]!.seq;
            if (events.length < 200 || stream.aborted) break;
          }
          // Before `again` is looked at: an event that comes while the status is read is read in
          // its turn, rather than waiting for one after it.
          if (moved) await status.tell();
        } while (again && !stream.aborted);
      };
      const wake = () => {
        if (pumping) {
          again = true;
          return;
        }
        pumping = pump()
          .catch(() => stream.abort())
          .finally(() => {
            pumping = null;
          });
      };

      const unsubscribe = deps.hub.subscribe({
        onEvents: (seq) => {
          if (seq > cursor) wake();
        },
        onStream: () => {},
        onStop: () => stream.abort(),
      });
      const keepAlive = setInterval(() => {
        void stillSignedIn(deps.kernel.db, token)
          .then(async (ok) => {
            if (!ok) return stream.abort();
            await stream.write(": keep-alive\n\n");
            // What no event announces: a component that stopped reporting, an approval run out.
            await status.tell();
          })
          .catch(() => {});
      }, KEEP_ALIVE_MS);
      const whileBusy = setInterval(() => {
        if (status.busy()) void status.tell();
      }, WHILE_BUSY_MS);
      const done = new Promise<void>((resolve) => stream.onAbort(resolve));

      await stream.writeSSE({ event: "ready", id: String(cursor), data: "{}" });
      await status.tell();
      wake();
      await done;
      clearInterval(keepAlive);
      clearInterval(whileBusy);
      unsubscribe();
      await pumping;
      await status.settled();
    });
  });

  // The desk (D84, auth/desk.ts): Windows Hello signs a fresh challenge with this PC's key, as the
  // window's sign-in does (D80), and the signature opens this token's desk and gives the app the
  // desk's secret. Each of these takes the app itself: its token, straight from this PC through no
  // proxy.
  app.post("/desk/challenge", async (c) => {
    if (!fromTheApp(c)) return c.json({ error: NOT_THE_APP }, 403);
    if (!(await helloKey(c.get("deps").kernel.db)))
      return c.json({ error: "Windows Hello isn't set up for this PC. Connect again." }, 409);
    c.header("Cache-Control", "no-store");
    return c.json({ challenge: desks.challenge(c.get("token")!) });
  });

  app.post("/desk/unlock", async (c) => {
    if (!fromTheApp(c)) return c.json({ error: NOT_THE_APP }, 403);
    const { kernel } = c.get("deps");
    const token = c.get("token")!;
    const body = unlockBody.safeParse(await c.req.json().catch(() => null));
    const locks = body.success ? desks.takeChallenge(body.data.challenge, token) : null;
    const key = await helloKey(kernel.db);
    if (!body.success || locks === null || !key)
      return c.json({ error: "That unlock ran out. Try again." }, 410);
    if (!signedByHello(key, body.data.challenge, body.data.signature)) {
      console.warn("[auth] desk unlock refused: not signed by this PC's Windows Hello key");
      return c.json({ error: "Windows Hello's signature didn't match." }, 401);
    }
    // Checked again now, after the key was read: a lock while it was read wins.
    const opened = desks.unlock(token, kernel.clock.now(), locks);
    if (!opened) return c.json({ error: "Windows locked meanwhile. Unlock again." }, 410);
    c.header("Cache-Control", "no-store");
    return c.json({
      secret: opened.secret,
      until: opened.until.toISOString(),
      idleUntil: opened.idleUntil.toISOString(),
    });
  });

  // Windows locked or went to sleep: the desk stays shut until Windows Hello opens it again.
  // Shutting it only takes power away, so it needs no secret.
  app.post("/desk/lock", (c) => {
    if (!fromTheApp(c)) return c.json({ error: NOT_THE_APP }, 403);
    desks.lock(c.get("token")!);
    return c.json(SHUT);
  });

  // Open only for whoever holds the desk's secret; to anyone else it reads shut.
  app.get("/desk", (c) => {
    if (!fromTheApp(c)) return c.json({ error: NOT_THE_APP }, 403);
    const now = c.get("deps").kernel.clock.now();
    const times = desks.check(c.get("token")!, c.req.header(DESK_HEADER), now);
    c.header("Cache-Control", "no-store");
    if (!times) return c.json(SHUT);
    return c.json({
      open: true,
      until: times.until.toISOString(),
      idleUntil: times.idleUntil.toISOString(),
    });
  });
  return app;
}
