import { PRINCIPAL } from "@hearth/core";
import { connect, event, session } from "@hearth/db";
import { decide, ownerCaller } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEVICE_SCOPES,
  keepDeviceScopes,
  listDevices,
  pairDevice,
  revokeDevice,
  syncDeviceScopes,
} from "./auth/devices.ts";
import { createApiToken, createSession, hashToken } from "./auth/tokens.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.destroy());

describe("device tokens", () => {
  it("lets the desktop app run only its own actions", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    const clean = await t.api("/api/actions/voice.clean", token, {
      method: "POST",
      json: { raw: "um hello there", save: false },
    });
    expect(clean.status).toBe(200);
    expect(await clean.json()).toMatchObject({ result: { text: "Hello there" } });

    await createApiToken(t.kernel.db, "laptop"); // so /mcp is on, and refuses the device itself
    for (const [path, method] of [
      ["/api/actions/task.list", "POST"],
      ["/api/actions/entity.restore", "POST"],
      ["/api/actions", "GET"],
      ["/api/devices/desktop/pair", "POST"],
      ["/api/events", "GET"],
      ["/mcp", "POST"],
    ] as const) {
      const res = await t.api(path, token, { method, ...(method === "POST" ? { json: {} } : {}) });
      expect([path, res.status]).toEqual([path, 403]);
    }
  });

  it("pairing again signs out the old code, and unpairing signs out the new one", async () => {
    const first = await pairDevice(t.kernel.db, "desktop");
    const second = await pairDevice(t.kernel.db, "desktop");
    const styles = (token: string) =>
      t.api("/api/actions/voice.styles", token, { method: "POST", json: {} });
    expect((await styles(first)).status).toBe(401);
    expect((await styles(second)).status).toBe(200);
    expect(await listDevices(t.kernel.db)).toMatchObject([{ name: "desktop" }]);
    expect(await revokeDevice(t.kernel.db, "desktop")).toBe(1);
    expect((await styles(second)).status).toBe(401);
    expect(await listDevices(t.kernel.db)).toEqual([]);
    await expect(pairDevice(t.kernel.db, "toaster")).rejects.toThrow();
  });

  it("talks to Jarvis as outside content, and sees only its own conversations", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    const post = (name: string, json: unknown) =>
      t.api(`/api/actions/${name}`, token, { method: "POST", json });
    const sent = await post("chat.send", { text: "what's on today" });
    expect(sent.status).toBe(200);
    const { result } = (await sent.json()) as { result: { conversationId: string; idx: number } };
    const [posted] = await t.kernel.db
      .select()
      .from(event)
      .where(eq(event.kind, "chat.message_posted"));
    expect(posted?.origin).toBe("untrusted");
    expect((await post("conversation.get", { id: result.conversationId })).status).toBe(200);

    const mine = await t.kernel.execute<{ conversationId: string }>(
      "chat.send",
      { text: "private" },
      ownerCaller(),
    );
    if (mine.status !== "ok") throw new Error("chat.send failed");
    const id = mine.result.conversationId;
    expect((await post("conversation.get", { id })).status).toBe(404);
    expect((await post("chat.send", { conversationId: id, text: "hi" })).status).toBe(404);
  });

  it("records meetings, but can't read them", async () => {
    const token = await pairDevice(t.kernel.db, "desktop");
    const post = (name: string, json: unknown) =>
      t.api(`/api/actions/${name}`, token, { method: "POST", json });
    const rec = await post("meeting.record", {});
    expect(rec.status).toBe(200);
    const { result } = (await rec.json()) as { result: { id: string; offsetMs: number } };
    expect(result.offsetMs).toBe(0);
    const segment = { id: "me:0", channel: "me", startMs: 0, endMs: 900, text: "Hello" };
    expect(
      (await post("meeting.add_segments", { id: result.id, segments: [segment] })).status,
    ).toBe(200);
    expect((await post("meeting.get", { id: result.id })).status).toBe(403);
    expect((await post("meeting.end", { id: result.id })).status).toBe(200);
  });

  it("gives tokens paired with an older list this build's scopes at start, and nothing more", async () => {
    const db = t.kernel.db;
    const device = (name: string, scopes: string[]) =>
      createSession(db, {
        principal: PRINCIPAL.owner,
        kind: "api",
        label: `device:${name}`,
        ttlDays: null,
        scopes,
      });
    const revoked = await device("desktop", ["voice.clean"]);
    await revokeDevice(db, "desktop");
    // Paired before the desk existed, with a scope since taken off the list.
    const paired = await device("desktop", ["voice.clean", "chat.send", "old.gone"]);
    const unknown = await device("toaster", ["voice.clean"]);
    // A browser's label is its user agent: one that happens to read like a device is no device.
    const browser = await createSession(db, {
      principal: PRINCIPAL.owner,
      kind: "browser",
      label: "device:desktop",
      ttlDays: 1,
    });
    const scopesOf = async (token: string) =>
      (
        await db
          .select()
          .from(session)
          .where(eq(session.tokenHash, hashToken(token)))
      )[0]?.scopes;
    const desk = () =>
      t.api("/api/desktop/desk", paired, {
        method: "GET",
        from: "127.0.0.1",
        headers: { host: "localhost:4400" },
      });
    expect((await desk()).status).toBe(403);

    const changes = await syncDeviceScopes(db);
    expect(changes).toEqual([
      {
        name: "desktop",
        added: DEVICE_SCOPES.desktop!.filter((s) => s !== "voice.clean" && s !== "chat.send"),
        removed: ["old.gone"],
      },
    ]);
    expect(await scopesOf(paired)).toEqual(DEVICE_SCOPES.desktop);
    expect(await scopesOf(revoked)).toEqual(["voice.clean"]);
    expect(await scopesOf(unknown)).toEqual(["voice.clean"]);
    expect(await scopesOf(browser)).toBeNull();
    expect((await desk()).status).toBe(200);
    // Once is enough: a second start changes nothing.
    expect(await syncDeviceScopes(db)).toEqual([]);
  });

  it("keeps trying at start while the database is out of reach, without holding the start up", async () => {
    const paired = await createSession(t.kernel.db, {
      principal: PRINCIPAL.owner,
      kind: "api",
      label: "device:desktop",
      ttlDays: null,
      scopes: ["voice.clean"],
    });
    // Nothing listens there: as on 2026-10-27, when the disk holding the database hung.
    const down = connect("postgres://hearth@127.0.0.1:9/none", { max: 1 });
    const warned: string[] = [];
    let tries = 0;
    try {
      const sync = keepDeviceScopes(
        () => (++tries === 1 ? syncDeviceScopes(down.db) : syncDeviceScopes(t.kernel.db)),
        { retryMs: [10], log: () => {}, warn: (line) => warned.push(line) },
      );
      // Started, but not waited for: the server goes on starting meanwhile.
      expect(tries).toBe(1);
      const changes = await sync.done;
      expect(tries).toBe(2);
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/trying again in 0 s/);
      expect(changes).toMatchObject([{ name: "desktop" }]);
      const [row] = await t.kernel.db
        .select()
        .from(session)
        .where(eq(session.tokenHash, hashToken(paired)));
      expect(row?.scopes).toEqual(DEVICE_SCOPES.desktop);

      // Stopped while it waits to try again, it tries no more.
      let failing = 0;
      const stopped = keepDeviceScopes(() => Promise.reject(new Error(`down ${++failing}`)), {
        retryMs: [5],
        warn: () => {},
      });
      stopped.stop();
      expect(await stopped.done).toBeNull();
      await new Promise((r) => setTimeout(r, 30));
      expect(failing).toBe(1);
    } finally {
      await down.close();
    }
  });

  it("gives the desktop app exactly this list, every action on it one its caller may run", () => {
    // A new scope is a new power for whoever holds the token (D42): it's added here on purpose.
    expect(DEVICE_SCOPES.desktop).toEqual([
      "voice.clean",
      "voice.command",
      "voice.command_result",
      "voice.styles",
      "chat.send",
      "conversation.get",
      "meeting.record",
      "meeting.add_segments",
      "meeting.end",
      "GET /api/voice/jobs/next",
      "POST /api/voice/jobs/:id",
      "system.status",
      "GET /api/desktop/notify",
      "POST /api/auth/desktop/hello/enroll",
      "POST /api/auth/desktop/hello/challenge",
      "POST /api/auth/desktop/hello/verify",
      // The desk's actions refuse the token until Windows Hello opens the desk (D84).
      "POST /api/desktop/desk/challenge",
      "POST /api/desktop/desk/unlock",
      "POST /api/desktop/desk/lock",
      "GET /api/desktop/desk",
      "desk.list",
      "desk.decide",
      "desk.mark",
      "desk.answer",
      "desk.reply",
      "desk.conversation",
    ]);
    const device = ownerCaller("device", { origin: "untrusted" });
    for (const name of DEVICE_SCOPES.desktop!.filter((s) => !s.includes(" "))) {
      const def = t.kernel.registry.action(name);
      expect([name, def && decide(def, device, false).kind]).toEqual([name, "allow"]);
    }
  });
});
