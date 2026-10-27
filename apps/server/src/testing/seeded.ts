// A seeded Nook for end-to-end tests: the real server and built web app with development login, on
// a database of its own on the test cluster, with a fake Google holding today's calendar and a
// small inbox (seed-world.ts) that Nook's own sync brings in and sorts. It runs in the test's own
// process, so the test can ask the fake what Nook sent it. Nothing here reaches Google.
//
// Only ever a test server: seedGate refuses unless HEARTH_DEV_AUTH=1, which the live install never
// has (its Windows service turns development login off, and doctor warns about it), and unless the
// test cluster is set and isn't the live one on 5432. `hearth serve` never loads this file.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDate } from "@hearth/core";
import { connect, migrateUp } from "@hearth/db";
import { adminUrl, withDatabase } from "@hearth/db/testing";
import { integrationCaller, Kernel, Registry } from "@hearth/kernel";
import { ALL_MODULES, BLOB_SERVICE, BlobStore, GOOGLE_SERVICE, SCOPES } from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import pg from "pg";
import { createApp } from "../app.ts";
import { closeAll, listen } from "../listen.ts";
import { deliverInbox, ME, putWeek, SEED_TZ } from "./seed-world.ts";

/** The live server's ports, here and through Tailscale. */
const LIVE_PORTS = new Set([4400, 4443]);

export interface Seeded {
  base: string;
  google: FakeGoogle;
  /** The day the events were put on ("2026-10-27"), where the week is laid out (SEED_TZ). */
  today: string;
  /** Each call Nook made to Google, with its whole address (sendUpdates is in the query). */
  sent: { method: string; url: URL }[];
  /** Stops the server and drops its database. */
  stop(): Promise<void>;
}

/** Why this can't be a seeded test server; nothing when it can. */
export function seedGate(env: NodeJS.ProcessEnv, port: number): string[] {
  const problems: string[] = [];
  if (env.HEARTH_DEV_AUTH !== "1")
    problems.push("A seeded server is a test server: set HEARTH_DEV_AUTH=1, as the e2e steps do.");
  if (LIVE_PORTS.has(port)) problems.push(`Port ${port} is the live server's.`);
  const raw = env.HEARTH_TEST_DATABASE_URL;
  if (!raw) {
    problems.push("Set HEARTH_TEST_DATABASE_URL to the test cluster.");
    return problems;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push("HEARTH_TEST_DATABASE_URL isn't a URL.");
    return problems;
  }
  // No port is Postgres's own, 5432: the cluster holding your data on a PC that runs Nook.
  if ((url.port || "5432") === "5432")
    problems.push("HEARTH_TEST_DATABASE_URL is on port 5432, the live cluster's.");
  return problems;
}

/** The database's name: this CI run's when there is one, so its cleanup drops it too. */
function nameFor(env: NodeJS.ProcessEnv, port: number): string {
  const prefix =
    env.HEARTH_CI_DB ?? `hearth_e2e${env.HEARTH_TEST_RUN ? `_${env.HEARTH_TEST_RUN}` : ""}`;
  const name = `${prefix}_seeded_${port}`.toLowerCase();
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Not a database name: ${name}`);
  return name;
}

async function admin(sql: string, env: NodeJS.ProcessEnv) {
  const c = new pg.Client({ connectionString: adminUrl(env) });
  await c.connect();
  try {
    await c.query(sql);
  } finally {
    await c.end();
  }
}

async function run<T>(kernel: Kernel, name: string): Promise<T> {
  const r = await kernel.execute<T>(name, {}, integrationCaller("google"));
  if (r.status !== "ok") throw new Error(`${name}: ${JSON.stringify(r)}`);
  return r.result;
}

/** Starts a seeded server on `port` (loopback only), serving the web app built in `webDist`. */
export async function startSeeded(opts: {
  port: number;
  webDist: string;
  env?: NodeJS.ProcessEnv;
}): Promise<Seeded> {
  const env = opts.env ?? process.env;
  const { port } = opts;
  const problems = seedGate(env, port);
  if (problems.length) throw new Error(`Not seeding a server: ${problems.join(" ")}`);
  const name = nameFor(env, port);
  const drop = () => admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`, env);
  await drop();
  await admin(`CREATE DATABASE ${name}`, env);
  const database = connect(withDatabase(name, env));
  const blobs = await mkdtemp(join(tmpdir(), "hearth-seeded-"));
  const undo = async () => {
    await database.close();
    await drop();
    await rm(blobs, { recursive: true, force: true });
  };
  try {
    await migrateUp(database.pool);
    const kernel = new Kernel({ db: database.db, registry: new Registry(ALL_MODULES) });
    const google = new FakeGoogle(ME);
    google.grants = ["openid", "email", ...SCOPES.gmail, ...SCOPES.calendar];
    // Kept with their queries: the fake's own list has only the path.
    const sent: Seeded["sent"] = [];
    const answer = google.fetch.bind(google);
    google.fetch = (url, init) => {
      sent.push({ method: init?.method ?? "GET", url: new URL(url) });
      return answer(url, init);
    };
    kernel.services[GOOGLE_SERVICE] = google.client(database.db);
    kernel.services[BLOB_SERVICE] = new BlobStore(blobs);
    const client = google.client(database.db);
    const signIn = new URL(
      await client.startSignIn(database.db, [...SCOPES.gmail, ...SCOPES.calendar]),
    );
    await client.finishSignIn(database.db, signIn.searchParams.get("state")!, "the-code");

    const today = localDate(new Date(), SEED_TZ);
    putWeek(google, today);
    deliverInbox(google);
    await run(kernel, "calendar.sync");
    for (let more = true; more; ) more = (await run<{ more: boolean }>(kernel, "mail.sync")).more;

    const base = `http://localhost:${port}`;
    const server = createApp({
      kernel,
      pool: database.pool,
      config: {
        host: "127.0.0.1",
        port,
        origin: base,
        devAuth: true,
        webDist: opts.webDist,
        chrome: { mode: "off", task: "", chromePath: null, profile: null, args: [] },
      },
    });
    server.start();
    const http = await listen(server.app.fetch, "127.0.0.1", port).catch(async (err) => {
      await server.stop();
      throw err;
    });
    server.attach(...http);
    return {
      base,
      google,
      today,
      sent,
      async stop() {
        const closed = closeAll(http);
        for (const h of http) h.closeAllConnections();
        await server.stop();
        await closed;
        await undo();
      },
    };
  } catch (err) {
    await undo();
    throw err;
  }
}
