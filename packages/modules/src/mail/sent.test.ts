// Mail you send is kept in its conversation, once: sent from Nook (kept at once, and not again
// when the sync sees it in Sent), or from Gmail itself, where a draft is sent by moving it from
// Drafts to Sent under the same id. An account synced before that was seen looks in Sent once.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailAccount, mailMessage } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "./blobs.ts";
import type { DraftView } from "./drafts.ts";
import type { ThreadSummary, ThreadView } from "./views.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };

let t: TestKernel;
let g: FakeGoogle;
let dir: string;

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.clock = t.clock;
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
const sync = () => ok<{ added: number }>("mail.sync", {}, integrationCaller("google"));

/** Ana's email, synced: the conversation a reply goes into. */
async function fromAna() {
  g.gmail.deliver({
    from: ANA,
    subject: "Dinner?",
    text: "Friday at 7?",
    messageId: "a1@friends.example",
  });
  await sync();
  const [thread] = await ok<ThreadSummary[]>("mail.threads");
  return thread!.id;
}
const mine = { from: { address: ME }, to: [ANA], subject: "Re: Dinner?", text: "Friday works." };
const reply = {
  ...mine,
  messageId: "me1@example.com",
  inReplyTo: "a1@friends.example",
  references: ["a1@friends.example"],
};
const said = async (threadId: string) =>
  (await ok<ThreadView>("mail.thread", { id: threadId })).messages.map((m) => [m.outbound, m.text]);
/** How many copies of a Gmail message Hearth keeps. */
const kept = async (gmailId: string) =>
  (await t.tdb.db.select().from(mailMessage).where(eq(mailMessage.providerId, gmailId))).length;

describe("mail you send", () => {
  it("sent from Nook, is in its conversation at once and stays there once after a sync", async () => {
    const threadId = await fromAna();
    const d = await ok<DraftView>("mail.draft", { threadId, text: "Friday works." });
    const sent = await ok<{ threadId: string }>("mail.send", { id: d.id });
    expect(sent.threadId).toBe(threadId);
    const both = [
      [false, "Friday at 7?"],
      [true, "Friday works."],
    ];
    expect(await said(threadId)).toEqual(both);
    // Gmail has it in Sent now, and the sync sees it there: it isn't kept a second time.
    await sync();
    await sync();
    expect(await said(threadId)).toEqual(both);
    const [inSent] = [...g.gmail.messages.values()].filter((m) => m.labelIds.includes("SENT"));
    expect(await kept(inSent!.id)).toBe(1);
  });

  it("sent from Gmail itself, from a draft written there, joins its conversation once", async () => {
    const threadId = await fromAna();
    // Written in Gmail over a few minutes: the draft is seen, and left out (drafts are Nook's own).
    const id = g.gmail.draft(reply);
    expect(await sync()).toMatchObject({ added: 0 });
    // Sent: Gmail moves the same message from Drafts to Sent.
    g.gmail.sendDraft(id);
    expect(await sync()).toMatchObject({ added: 1 });
    expect(await said(threadId)).toEqual([
      [false, "Friday at 7?"],
      [true, "Friday works."],
    ]);
    await sync();
    expect(await kept(id)).toBe(1);
    // Pip and the inbox see it was answered: the conversation waits on Ana now.
    const [thread] = await ok<ThreadSummary[]>("mail.threads", { view: "all" });
    expect(thread).toMatchObject({ id: threadId, messageCount: 2, waiting: "them" });
  });

  it("written and sent in Gmail between two syncs, is kept once too", async () => {
    const threadId = await fromAna();
    g.gmail.sendDraft(g.gmail.draft(reply));
    expect(await sync()).toMatchObject({ added: 1 });
    expect((await said(threadId)).at(-1)).toEqual([true, "Friday works."]);
  });
});

describe("an account synced before sent mail was kept", () => {
  /** The account as it was: synced, but its Sent never looked in. */
  async function before() {
    await sync();
    await t.tdb.db
      .update(mailAccount)
      .set({ cursor: sql`${mailAccount.cursor} - 'lookedInSent'` })
      .where(eq(mailAccount.address, ME));
  }

  it("looks in Sent once, and brings in what it missed into its conversations", async () => {
    const threadId = await fromAna();
    // Sent while the sync didn't keep it: in Gmail's Sent, with nothing left in its history.
    const missed = g.gmail.seed(reply, ["SENT"]);
    const already = g.gmail.deliver({ ...mine, subject: "Older", text: "Kept" }, ["SENT"]);
    await before();
    expect(await kept(missed)).toBe(0);
    expect(await kept(already)).toBe(1);
    await sync();
    expect((await said(threadId)).at(-1)).toEqual([true, "Friday works."]);
    expect(await kept(missed)).toBe(1);
    // What it kept already isn't fetched again.
    expect(await kept(already)).toBe(1);
    expect(g.gmail.gets.get(already)).toBe(1);
    // Once: later syncs don't look in Sent again.
    const lists = g.gmail.count("GET /messages");
    await sync();
    await sync();
    expect(g.gmail.count("GET /messages")).toBe(lists);
    expect(await kept(missed)).toBe(1);
  });

  it("doesn't look again for a new account: its first sync brings Sent in with the rest", async () => {
    g.gmail.seed(mine, ["SENT"]);
    expect(await sync()).toMatchObject({ added: 1 });
    const [row] = await t.tdb.db.select().from(mailAccount).where(eq(mailAccount.address, ME));
    expect(row?.cursor).toMatchObject({ lookedInSent: true });
    expect(g.gmail.count("GET /messages")).toBe(1);
  });
});
