// The desktop app at its desk (D84), for tests: paired, with this PC's Windows Hello key, which an
// RSA key plays as Windows Hello makes them, and every request straight from this PC with the
// desk's secret once it has one.
import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { DESK_HEADER } from "../auth/desk.ts";
import { pairDevice } from "../auth/devices.ts";
import { saveHelloKey } from "../auth/hello.ts";
import { createTestServer, type TestServer } from "./server.ts";

/** A Windows Hello key: RSA, 2048 bits, its public half as SubjectPublicKeyInfo in base64. */
export function helloKey() {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return { spki, privateKey };
}

export const signed = (key: KeyObject, challenge: string) =>
  sign("sha256", Buffer.from(challenge), key).toString("base64");

export interface AppInit {
  method?: string;
  json?: unknown;
  /** The desk's secret to send: the last unlock's unless given; null sends none. */
  secret?: string | null;
  /** More headers; a Host here replaces this PC's. */
  headers?: Record<string, string>;
  /** Where the request comes from: this PC unless given. */
  from?: string;
  /** Another token than the app's. */
  token?: string;
}

export interface DeskApp {
  t: TestServer;
  /** The app's token; a test that pairs again puts the new one here. */
  token: string;
  key: ReturnType<typeof helloKey>;
  /** The secret the last unlock gave, as the app keeps it in memory. */
  secret: string | null;
  /** A request with the app's token, straight to Hearth's address on this PC. */
  fromApp(path: string, init?: AppInit): Promise<Response>;
  /** One of the app's actions, and its answer. */
  act(
    name: string,
    json?: unknown,
    init?: AppInit,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  challenge(): Promise<string>;
  /** Windows Hello signs a fresh challenge: the desk is open, and the app has its secret. */
  unlock(): Promise<{ secret: string; until: string; idleUntil: string }>;
  isOpen(): Promise<boolean>;
}

export async function deskApp(): Promise<DeskApp> {
  const t = await createTestServer();
  const token = await pairDevice(t.kernel.db, "desktop");
  const key = helloKey();
  await saveHelloKey(t.kernel.db, key.spki);
  const app: DeskApp = {
    t,
    token,
    key,
    secret: null,
    fromApp(path, init = {}) {
      const secret = init.secret === undefined ? app.secret : init.secret;
      return t.api(path, init.token ?? app.token, {
        method: init.method ?? "POST",
        ...(init.json !== undefined ? { json: init.json } : {}),
        from: init.from ?? "127.0.0.1",
        headers: {
          host: "localhost:4400",
          ...(secret ? { [DESK_HEADER]: secret } : {}),
          ...init.headers,
        },
      });
    },
    async act(name, json = {}, init = {}) {
      const res = await app.fromApp(`/api/actions/${name}`, { ...init, json });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    async challenge() {
      const res = await app.fromApp("/api/desktop/desk/challenge");
      if (res.status !== 200) throw new Error(`challenge: ${res.status}`);
      return ((await res.json()) as { challenge: string }).challenge;
    },
    async unlock() {
      const c = await app.challenge();
      const res = await app.fromApp("/api/desktop/desk/unlock", {
        json: { challenge: c, signature: signed(key.privateKey, c) },
      });
      if (res.status !== 200) throw new Error(`unlock: ${res.status}`);
      const opened = (await res.json()) as { secret: string; until: string; idleUntil: string };
      app.secret = opened.secret;
      return opened;
    },
    async isOpen() {
      const res = await app.fromApp("/api/desktop/desk", { method: "GET" });
      return ((await res.json()) as { open: boolean }).open;
    },
  };
  return app;
}
