// A web page's title for a note's link card (/api/links/title): read from the page's head, and
// never fetched from this PC or your home network, whatever the link says.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApiToken } from "./auth/tokens.ts";
import { farLookup, isNearby, pageTitle, titleIn } from "./routes/links.ts";
import { createTestServer, type TestServer } from "./testing/server.ts";

describe("titleIn", () => {
  it("reads what the page says to share it as, or else its title, in plain words", () => {
    const head = (s: string) => `<html><head>${s}</head><body>hi</body></html>`;
    expect(
      titleIn(head('<title>Old</title><meta property="og:title" content="New &amp; better">')),
    ).toBe("New & better");
    expect(titleIn(head("<meta content='Hers' name=\"twitter:title\">"))).toBe("Hers");
    expect(titleIn(head("<title>\n  Rain   &#8212; today\u200b </title>"))).toBe("Rain — today");
    expect(titleIn(head("<meta charset=utf-8>"))).toBeNull();
    expect(titleIn(head(`<title>${"x".repeat(500)}</title>`))?.length).toBe(200);
  });
});

describe("isNearby", () => {
  it("is this PC, your network and addresses no one has; not the web", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.9",
      "172.20.0.1",
      "169.254.169.254",
      "100.100.1.1",
      "0.0.0.0",
      "::1",
      "::",
      "fe80::1",
      "fd12::1",
      "::ffff:127.0.0.1",
      "nonsense",
    ])
      expect(isNearby(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
      expect(isNearby(ip), ip).toBe(false);
  });

  it("refuses a name that leads to this PC as the connection is made", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((done) =>
      farLookup("localhost", {}, (e) => done(e)),
    );
    expect(err?.code).toBe("ENEARBY");
  });
});

describe("pageTitle", () => {
  it("never fetches from this PC or your network, an unusual port, or anything but the web", async () => {
    let hits = 0;
    const local = createServer((_req, res) => {
      hits++;
      res.setHeader("content-type", "text/html");
      res.end("<title>secret</title>");
    });
    await new Promise<void>((done) => local.listen(0, "127.0.0.1", done));
    const { port } = local.address() as AddressInfo;
    try {
      for (const url of [
        `http://127.0.0.1:${port}/`,
        `http://localhost:${port}/`,
        "http://127.0.0.1/",
        "http://localhost/",
        "http://[::1]/",
        "http://192.168.1.1/admin",
        "http://router.lan/",
        "ftp://example.com/",
        "file:///C:/Windows/win.ini",
        "https://user:pw@example.com/",
        "https://example.com:8443/",
        "not a link",
      ])
        expect(await pageTitle(url), url).toBeNull();
      expect(hits).toBe(0);
    } finally {
      local.close();
    }
  });
});

describe("/api/links/title", () => {
  let t: TestServer | undefined;
  afterEach(async () => {
    await t?.destroy();
    t = undefined;
  });

  it("answers you with the title, or null, and no one else", async () => {
    t = await createTestServer({ devAuth: true });
    const ask = (url: unknown) => t!.browser("/api/links/title", { method: "POST", json: { url } });
    const local = await ask("http://127.0.0.1/");
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ title: null });
    expect((await ask("")).status).toBe(400);
    expect((await ask(42)).status).toBe(400);
    const { token } = await createApiToken(t.kernel.db, "laptop");
    const other = await t.api("/api/links/title", token, {
      method: "POST",
      json: { url: "https://example.com" },
    });
    expect(other.status).toBe(403);
  });
});
