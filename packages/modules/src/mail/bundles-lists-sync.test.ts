// A person's mail through a list or a group, sorted on a sync (M-02): a colleague's post to your
// company's group and a customer's to sales@ are People; a lone list post, a newsletter to a
// catch-all alias and your CI's mail are not; Gmail's tab alone doesn't keep a person out, but a
// Noise rule of yours does, and a webinar's invitation stays out. And the inbox is sorted again
// after a restart, all but what you moved by hand. The rules themselves: bundles-lists.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailAccount, mailThread } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import { AGAIN_ROUNDS, sortedAgain } from "./bundle-sort.ts";
import type { MailBundle } from "./bundles.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const ME = "owner@example.com";
const PERSONAL = ["INBOX", "UNREAD", "CATEGORY_PERSONAL"];
const UPDATES = ["INBOX", "UNREAD", "CATEGORY_UPDATES"];
const PROMOTIONS = ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"];
const FORUMS = ["INBOX", "UNREAD", "CATEGORY_FORUMS"];

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
const idOf = async (subject: string) =>
  (await ok<ThreadSummary[]>("mail.threads", { view: "all" })).find((x) => x.subject === subject)!
    .id;

const group = (name: string) => ({ "List-Id": `${name} <${name}.example.com>` });
const CLUB = { "List-Id": "book-club <book-club.googlegroups.com>" };
const club = { address: "book-club@googlegroups.com" };

/** Mail through lists and groups, and mail that only looks like it. */
function deliverLists() {
  const mail = (
    from: string,
    to: string,
    subject: string,
    headers: Record<string, string>,
    labels: string[],
  ) =>
    g.gmail.deliver(
      { from: { address: from }, to: [{ address: to }], subject, text: "Hi", headers },
      labels,
    );
  mail("dana@example.com", "eng@example.com", "Deploy freeze on Friday", group("eng"), FORUMS);
  mail("pat@client.example", "sales@example.com", "Quote for 40 seats", group("sales"), PERSONAL);
  mail("jane@janedoe.example", "news@example.com", "Issue 12: shipping alone", group("x"), FORUMS);
  const ci = { "Auto-Submitted": "auto-generated" };
  mail("jenkins@example.com", "eng@example.com", "Build #812 failed", ci, UPDATES);
  g.gmail.deliver(
    {
      from: { address: "sam@gmail.com" },
      to: [club],
      subject: "[book-club] Next month",
      text: "Dune?",
      messageId: "next@club",
      headers: CLUB,
    },
    FORUMS,
  );
}

/** A calendar invitation from its organizer, as a webinar sends it. */
const webinar = (from: string) =>
  Buffer.from(
    [
      `From: ${from}`,
      `To: ${ME}`,
      "Subject: Invitation: Scaling your sales team",
      "Date: Thu, 01 Oct 2026 12:00:00 +0000",
      "Message-ID: <webinar-1@vendor.example>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Join us live.",
      "--b",
      "Content-Type: text/calendar; charset=UTF-8; method=REQUEST",
      "",
      "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:webinar-1@vendor.example",
      "SUMMARY:Scaling your sales team\r\nDTSTART:20261005T150000Z\r\nDTEND:20261005T160000Z",
      `ORGANIZER;CN=Vendor:mailto:${from}\r\nEND:VEVENT\r\nEND:VCALENDAR`,
      "--b--",
      "",
    ].join("\r\n"),
  );

describe("mail through lists and groups", () => {
  it("puts a person's mail through a group in People, and a list post once someone answers", async () => {
    deliverLists();
    await sync();
    expect(await subjects("people")).toEqual(["Deploy freeze on Friday", "Quote for 40 seats"]);
    expect(await subjects("newsletters")).toEqual([
      "Issue 12: shipping alone",
      "[book-club] Next month",
    ]);
    expect(await subjects("updates")).toEqual(["Build #812 failed"]);
    g.gmail.deliver(
      {
        from: { address: "lee@gmail.com" },
        to: [club],
        subject: "Re: [book-club] Next month",
        text: "Yes!",
        inReplyTo: "next@club",
        references: ["next@club"],
        headers: CLUB,
      },
      FORUMS,
    );
    await sync();
    expect(await subjects("people")).toContain("[book-club] Next month");
    expect(await subjects("newsletters")).toEqual(["Issue 12: shipping alone"]);
  });

  it("keeps a webinar's invitation out of People, and a person whose domain you sent to Noise", async () => {
    const id = g.gmail.deliver({ from: { address: "x@y.example" }, subject: "x", text: "x" }, [
      ...PROMOTIONS,
    ]);
    g.gmail.messages.get(id)!.raw = webinar("events@vendor.example");
    deliverLists();
    await sync();
    expect(await subjects("updates")).toContain("Invitation: Scaling your sales team");
    // A Noise rule for the customer's whole domain is your word on them, through sales@ or not.
    await ok("mail.set_lane", { sender: "client.example", lane: "noise" });
    expect(await subjects("people")).toEqual(["Deploy freeze on Friday"]);
    expect(await subjects("newsletters")).toContain("Quote for 40 seats");
    await ok("mail.set_lane", { sender: "client.example", lane: "signal" });
    expect(await subjects("people")).toContain("Quote for 40 seats");
  });

  it("sorts the inbox again after a restart, all but what you moved by hand", async () => {
    deliverLists();
    await sync();
    // As sorted before these rules, and one of them moved there by hand.
    const dana = await idOf("Deploy freeze on Friday");
    await ok("mail.set_bundle", { threadId: await idOf("Quote for 40 seats"), bundle: "updates" });
    await t.tdb.db
      .update(mailThread)
      .set({ bundle: "newsletters" })
      .where(eq(mailThread.entityId, dana));
    await sync();
    expect(await subjects("newsletters")).toContain("Deploy freeze on Friday");
    sortedAgain.clear();
    await sync();
    expect(await subjects("people")).toEqual(["Deploy freeze on Friday"]);
    expect(await subjects("updates")).toContain("Quote for 40 seats");
    expect((await ok<ThreadView>("mail.thread", { id: dana })).bundleMoved).toBe(false);
    // The next round finds nothing more to move, and that's the end of it.
    await sync();
    const [account] = await t.tdb.db.select({ id: mailAccount.id }).from(mailAccount);
    expect(sortedAgain.get(account!.id)).toBe(AGAIN_ROUNDS);
  });
});
