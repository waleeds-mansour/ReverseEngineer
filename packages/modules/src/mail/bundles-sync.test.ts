// Bundles end to end: sync sorts what it brings in, the inbox lists and counts a bundle at a time,
// a conversation moved by hand stays where it was put, and conversations from before bundles are
// sorted by the next syncs. The rules themselves are in bundles.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailThread } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { BundleCount } from "./bundle-actions.ts";
import type { MailBundle } from "./bundles.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const GITHUB = { address: "notifications@github.com", name: "Sam Lee" };
const UPDATES = ["INBOX", "UNREAD", "CATEGORY_UPDATES"];
const PROMOTIONS = ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"];

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("mail.sync", {}, integrationCaller("google"));
const subjects = async (bundle: MailBundle) =>
  (await ok<ThreadSummary[]>("mail.threads", { bundle })).map((x) => x.subject).sort();
const counts = async () =>
  Object.fromEntries(
    (await ok<BundleCount[]>("mail.bundles")).map((b) => [
      b.bundle,
      { count: b.count, unread: b.unread, senders: b.senders },
    ]),
  );
const idOf = async (subject: string) =>
  (await ok<ThreadSummary[]>("mail.threads", { view: "all" })).find((x) => x.subject === subject)!
    .id;

/** The kinds of mail an inbox gets, one each. */
function deliverAKindOfEach() {
  g.gmail.deliver({ from: ANA, subject: "Lunch?", text: "Friday?", messageId: "lunch@friends" });
  g.gmail.deliver(
    {
      from: GITHUB,
      subject: "[acme/web] Fix invoice export (PR #42)",
      text: "Sam opened a pull request.",
      messageId: "pr42@github.com",
      headers: {
        "List-Id": "acme/web <web.acme.github.com>",
        "Reply-To": "reply+ABCD@reply.github.com",
      },
    },
    UPDATES,
  );
  g.gmail.deliver(
    {
      from: { address: "auto-confirm@amazon.com", name: "Amazon.com" },
      subject: 'Your Amazon.com order of "Dune"',
      text: "Thanks for your order.",
      messageId: "dune@amazon.com",
    },
    UPDATES,
  );
  g.gmail.deliver(
    {
      from: { address: "news@stratechery.example", name: "Stratechery" },
      subject: "The week in tech",
      text: "Hello readers.",
      headers: { "List-Unsubscribe": "<mailto:leave@stratechery.example>" },
    },
    PROMOTIONS,
  );
}

describe("mail bundles", () => {
  it("sorts what sync brings in, and lists and counts the inbox a bundle at a time", async () => {
    deliverAKindOfEach();
    await sync();
    expect(await subjects("people")).toEqual(["Lunch?"]);
    expect(await subjects("updates")).toEqual(["[acme/web] Fix invoice export (PR #42)"]);
    expect(await subjects("receipts")).toEqual(['Your Amazon.com order of "Dune"']);
    expect(await subjects("newsletters")).toEqual(["The week in tech"]);
    // GitHub's notices carry whoever acted, so they're named by GitHub's domain.
    expect(await counts()).toEqual({
      people: { count: 1, unread: 1, senders: ["Ana Silva"] },
      updates: { count: 1, unread: 1, senders: ["github.com"] },
      receipts: { count: 1, unread: 1, senders: ["Amazon.com"] },
      newsletters: { count: 1, unread: 1, senders: ["Stratechery"] },
    });
    // Each conversation says its bundle, and Pip reads it in the conversation's head.
    const lunch = await ok<ThreadView>("mail.thread", { id: await idOf("Lunch?") });
    expect(lunch.bundle).toBe("people");
    // Out of the inbox, out of its bundle's count.
    await ok("mail.archive", { ids: [await idOf("The week in tech")] });
    expect((await counts()).newsletters).toEqual({ count: 0, unread: 0, senders: [] });
  });

  it("makes a conversation People once you write in it", async () => {
    deliverAKindOfEach();
    await sync();
    // Your answer to the order joins it by its headers.
    g.gmail.deliver(
      {
        from: { address: ME },
        to: [{ address: "auto-confirm@amazon.com" }],
        subject: 'Re: Your Amazon.com order of "Dune"',
        text: "It never came.",
        inReplyTo: "dune@amazon.com",
        references: ["dune@amazon.com"],
      },
      ["SENT"],
    );
    await sync();
    expect(await subjects("receipts")).toEqual([]);
    expect(await subjects("people")).toEqual(["Lunch?", 'Your Amazon.com order of "Dune"']);
  });

  it("keeps a conversation where you moved it, through new mail and changes", async () => {
    deliverAKindOfEach();
    await sync();
    const pr = await idOf("[acme/web] Fix invoice export (PR #42)");
    // It says where it was, for an Undo to put it back.
    expect(await ok("mail.set_bundle", { threadId: pr, bundle: "people" })).toEqual({
      threadId: pr,
      bundle: "people",
      moved: true,
      previous: { bundle: "updates", moved: false },
    });
    expect((await t.events("mail.changed")).map((e) => e.entityId)).toContain(pr);
    // Another notice in the same conversation, and a star: it stays in People.
    g.gmail.deliver(
      {
        from: GITHUB,
        subject: "Re: [acme/web] Fix invoice export (PR #42)",
        text: "Merged.",
        inReplyTo: "pr42@github.com",
        references: ["pr42@github.com"],
        headers: { "List-Id": "acme/web <web.acme.github.com>" },
      },
      UPDATES,
    );
    await sync();
    await ok("mail.star", { ids: [pr] });
    expect(await subjects("people")).toEqual(["Lunch?", "[acme/web] Fix invoice export (PR #42)"]);
    expect(await subjects("updates")).toEqual([]);
    // Let go, the rules sort it again, and it says it was moved by hand before.
    expect(await ok("mail.set_bundle", { threadId: pr, auto: true })).toEqual({
      threadId: pr,
      bundle: "updates",
      moved: false,
      previous: { bundle: "people", moved: true },
    });
    expect(await subjects("updates")).toEqual(["[acme/web] Fix invoice export (PR #42)"]);
    // A conversation that isn't one is refused, and so is a move to nowhere or two places.
    for (const input of [
      { threadId: "00000000-0000-7000-8000-000000000999", bundle: "updates" },
      { threadId: pr },
      { threadId: pr, bundle: "people", auto: true },
    ])
      expect((await t.kernel.execute("mail.set_bundle", input, ownerCaller())).status).toBe(
        "error",
      );
  });

  it("keeps a sender you sent to Noise out of People, at once", async () => {
    deliverAKindOfEach();
    await sync();
    await ok("mail.set_lane", { sender: ANA.address, lane: "noise" });
    expect(await subjects("people")).toEqual([]);
    expect(await subjects("updates")).toContain("Lunch?");
    // Back to Signal, back to People.
    await ok("mail.set_lane", { sender: ANA.address, lane: "signal" });
    expect(await subjects("people")).toEqual(["Lunch?"]);
  });

  it("is sorting your own mail, which Pip does on its own even after reading an email", async () => {
    deliverAKindOfEach();
    await sync();
    const lunch = await idOf("Lunch?");
    const res = await t.kernel.execute(
      "mail.set_bundle",
      { threadId: lunch, bundle: "updates" },
      jarvisCaller("untrusted", { mode: "proactive" }),
    );
    expect(res.status).toBe("ok");
    expect(await subjects("updates")).toContain("Lunch?");
  });

  it("sorts conversations from before bundles on the next sync, showing them with People till then", async () => {
    deliverAKindOfEach();
    await sync();
    const pr = await idOf("[acme/web] Fix invoice export (PR #42)");
    await ok("mail.set_bundle", { threadId: pr, bundle: "receipts" });
    // As after 0058: nothing sorted, and none of it moved by hand.
    await t.tdb.db.update(mailThread).set({ bundle: null, bundleMoved: false });
    expect(await subjects("people")).toHaveLength(4);
    expect((await counts()).people?.count).toBe(4);
    await sync();
    expect(await t.tdb.db.select().from(mailThread).where(isNull(mailThread.bundle))).toEqual([]);
    expect(await subjects("people")).toEqual(["Lunch?"]);
    expect(await subjects("updates")).toEqual(["[acme/web] Fix invoice export (PR #42)"]);
    expect(await subjects("receipts")).toEqual(['Your Amazon.com order of "Dune"']);
    expect(await subjects("newsletters")).toEqual(["The week in tech"]);
  });

  it("puts mail you sent in People, and someone you've written to stays there", async () => {
    g.gmail.deliver({ from: { address: ME }, to: [ANA], subject: "Hello", text: "Hi Ana" }, [
      "SENT",
    ]);
    await sync();
    const hello = await ok<ThreadView>("mail.thread", { id: await idOf("Hello") });
    expect(hello.bundle).toBe("people");
    // Ana's newsletter is still a newsletter, though you know her.
    g.gmail.deliver({
      from: ANA,
      subject: "Ana's monthly letter",
      text: "Hi all",
      headers: { "List-Unsubscribe": "<mailto:leave@friends.example>" },
    });
    g.gmail.deliver({ from: ANA, subject: "Dinner?", text: "Saturday?" }, UPDATES);
    await sync();
    expect(await subjects("newsletters")).toEqual(["Ana's monthly letter"]);
    expect(await subjects("people")).toEqual(["Dinner?"]);
  });
});
