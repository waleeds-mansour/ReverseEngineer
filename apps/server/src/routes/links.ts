// /api/links/title: a web page's title, for a link card in a note. Hearth fetches the page itself,
// as little of it as it can: only http and https on their usual ports, never an address on this PC
// or your home network (checked for every redirect, and for the address a name resolves to as it
// connects, so a name can't point somewhere else afterwards), five seconds at most, and only the
// start of the page, where the title is. No cookies go with it. Answers are kept for a few hours.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireCaller } from "../auth/middleware.ts";
import type { AppEnv } from "../env.ts";

const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5000;
const REDIRECTS = 3;
const KEEP_MS = 6 * 60 * 60 * 1000;

const NEARBY = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  NEARBY.addSubnet(net, bits, "ipv4");
// This PC, v4 by way of v6, local and link-local networks, and multicast.
for (const [net, bits] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NEARBY.addSubnet(net, bits, "ipv6");
// A v4 address written as v6. Apart: a list checks every v4 address against this one too.
const MAPPED = new BlockList();
MAPPED.addSubnet("::ffff:0:0", 96, "ipv6");

/** An address on this PC, your network, or no one's: never fetched. */
export function isNearby(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return NEARBY.check(ip, "ipv4");
  return v === 0 || MAPPED.check(ip, "ipv6") || NEARBY.check(ip, "ipv6");
}

type Found = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** Resolves a name as the connection is made, refusing it if any address it has is nearby. */
export function farLookup(host: string, opts: { all?: boolean }, done: Found): void {
  dnsLookup(host, { all: true }, (err, list) => {
    if (err) return done(err, "");
    if (!list.length || list.some((a) => isNearby(a.address)))
      return done(
        Object.assign(new Error(`${host} is on your own network.`), { code: "ENEARBY" }),
        "",
      );
    if (opts.all) done(null, list);
    else done(null, list[0]!.address, list[0]!.family);
  });
}

/** Whether Hearth may fetch `url` at all, before asking where its name goes. */
function mayFetch(url: URL): boolean {
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.port && url.port !== "80" && url.port !== "443") return false;
  if (url.username || url.password) return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !isNearby(host);
  return host.includes(".") && !/(^|\.)(localhost|local|internal|lan|home\.arpa)$/i.test(host);
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] !== "#") return NAMED[code.toLowerCase()] ?? whole;
    const n =
      code[1]?.toLowerCase() === "x" ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });

/** A page's title: what it says to share it as (og:title), or else its <title>. */
export function titleIn(html: string): string | null {
  const meta = (name: string) => {
    const tag = new RegExp(
      `<meta\\s[^>]*(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`,
      "i",
    ).exec(html);
    const m = tag && /\scontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[0]);
    return m ? (m[1] ?? m[2]) : undefined;
  };
  const raw =
    meta("og:title") || meta("twitter:title") || /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = decode(raw ?? "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.slice(0, 200) : null;
}

interface Answer {
  status: number;
  location: string | null;
  html: string | null;
}

/** One request: a redirect's address, or the start of a web page. */
function get(url: URL): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? https : http).get(
      url,
      {
        lookup: farLookup,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Nook link preview)",
          accept: "text/html,application/xhtml+xml;q=0.9",
          "accept-encoding": "identity",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const type = String(res.headers["content-type"] ?? "");
        if (status !== 200 || !/html/i.test(type)) {
          res.destroy();
          return resolve({ status, location: res.headers.location ?? null, html: null });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const done = () => {
          const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? "utf-8";
          let text: string;
          try {
            text = new TextDecoder(charset).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES));
          } catch {
            text = Buffer.concat(chunks).subarray(0, MAX_BYTES).toString("utf8");
          }
          resolve({ status, location: null, html: text });
        };
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          // The title is in the head: once that's in, or enough is, the rest isn't needed.
          if (size >= MAX_BYTES || /<\/head>/i.test(c.toString("latin1"))) {
            res.destroy();
            done();
          }
        });
        res.on("end", done);
        res.on("error", done);
      },
    );
    req.on("error", reject);
  });
}

/** The title of the page at `raw`, or null: not a page Hearth may fetch, or none found. */
export async function pageTitle(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  for (let hop = 0; hop <= REDIRECTS; hop++) {
    if (!mayFetch(url)) return null;
    const res = await get(url).catch(() => null);
    if (!res) return null;
    if (res.html !== null) return titleIn(res.html);
    if (res.status < 300 || res.status >= 400 || !res.location) return null;
    try {
      url = new URL(res.location, url);
    } catch {
      return null;
    }
  }
  return null;
}

/** The routes; `find` is how a title is found (tests pass one that fetches nothing). */
export function linkRoutes(find: (url: string) => Promise<string | null> = pageTitle) {
  const kept = new Map<string, { title: string | null; at: number }>();
  const r = new Hono<AppEnv>();
  r.use("*", requireCaller(["owner"]));
  // The address in the body, not the path: a link can carry a key, and paths are logged.
  r.post("/title", bodyLimit({ maxSize: 4096 }), async (c) => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    const url = typeof body?.url === "string" ? body.url.trim() : "";
    if (!url || url.length > 2048) return c.json({ error: "Which page?" }, 400);
    const hit = kept.get(url);
    if (hit && Date.now() - hit.at < KEEP_MS) return c.json({ title: hit.title });
    const title = await find(url);
    if (kept.size >= 500) kept.delete(kept.keys().next().value!);
    kept.set(url, { title, at: Date.now() });
    return c.json({ title });
  });
  return r;
}
