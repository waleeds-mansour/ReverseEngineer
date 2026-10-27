// Undo for what Pip did to your mail on its own (the owner, 2026-10-27): an archive goes back to
// the inbox, a trash comes back out until Gmail empties it, and read or starred goes back as it
// was, for just the messages Pip changed, here and at Gmail. Greyed once you've changed it since,
// in Nook or in Gmail, and never sends anything.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mailMessage, mailThread } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "../mail/blobs.ts";
import type { UndoView } from "./shape.ts";

const ME = "owner@example.com";
const ANA = { address: "ana@friends.example", name: "Ana Silva" };
const DAY = 86_400_000;

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
  // Undo never sends mail.
  expect(g.gmail.sent).toHaveLength(0);
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
/** Pip, triaging on its own after mail came in. */
const pip = () => jarvisCaller("untrusted", { correlationId: newId(), mode: "proactive" });
/** Sends Nook's changes to Gmail and brings Gmail's in. */
const sync = () => ok("mail.sync", {}, integrationCaller("google"));
const undos = () => ok<UndoView[]>("activity.undos", { since: "2026-09-30T00:00:00Z" });
const press = (v: UndoView) => t.kernel.execute("activity.undo", { ref: v.ref }, ownerCaller());
const thread = async (id: string) =>
  (await t.tdb.db.select().from(mailThread).where(eq(mailThread.entityId, id)))[0]!;
/** Nook's flags on a message, by its Gmail id. */
const flags = async (gid: string) =>
  (await t.tdb.db.select().from(mailMessage).where(eq(mailMessage.providerId, gid)))[0]!.labels;
const atGmail = (gid: string) => g.gmail.messages.get(gid)!.labelIds;

/** Ana's "Lunch?", in the inbox, and the conversation's id. */
async function lunch(labels?: string[]) {
  const gid = g.gmail.deliver(
    { from: ANA, subject: "Lunch?", text: "Friday?", messageId: "a1@friends.example" },
    labels,
  );
  await sync();
  const [m] = await t.tdb.db.select().from(mailMessage).where(eq(mailMessage.providerId, gid));
  return { gid, id: m!.threadId };
}

describe("Undo for an archive", () => {
  it("puts it back in the inbox, here and at Gmail, then says it's undone", async () => {
    const { gid, id } = await lunch();
    await ok("mail.archive", { ids: [id] }, pip());
    const [v] = await undos();
    expect(v).toMatchObject({
      how: "changed",
      did: "Archived: Lunch?",
      label: 'Undo: put "Lunch?" back in the inbox',
      blocked: null,
      entityId: id,
      entityType: "email_thread",
      outside: true,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect((await thread(id)).inInbox).toBe(true);
    await sync();
    expect(atGmail(gid)).toContain("INBOX");
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });

  it("is greyed and refused once you've archived it again yourself, which it leaves", async () => {
    const { id } = await lunch();
    await ok("mail.archive", { ids: [id] }, pip());
    await ok("mail.unarchive", { ids: [id] });
    await ok("mail.archive", { ids: [id] });
    const [v] = await undos();
    expect(v).toMatchObject({ blocked: "You've changed it since", undone: false });
    expect(await press(v!)).toMatchObject({ status: "error", code: "conflict" });
    expect((await thread(id)).inInbox).toBe(false);
  });

  it("is greyed once it's back in the inbox from Gmail", async () => {
    const { gid, id } = await lunch();
    await ok("mail.archive", { ids: [id] }, pip());
    await sync();
    g.gmail.label(gid, ["INBOX"], []);
    await sync();
    expect((await undos())[0]).toMatchObject({ blocked: "It's changed since" });
  });
});

describe("Undo for a trash", () => {
  it("brings out just what Pip trashed, and back to the inbox only what was there", async () => {
    const { gid, id } = await lunch();
    const reply = g.gmail.deliver(
      {
        from: { address: ME },
        to: [ANA],
        subject: "Re: Lunch?",
        text: "Yes!",
        messageId: "me1@example.com",
        inReplyTo: "a1@friends.example",
        references: ["a1@friends.example"],
      },
      ["SENT"],
    );
    await sync();
    await ok("mail.trash", { ids: [id] }, pip());
    expect(await flags(reply)).toContain("TRASH");
    // Good past the week: Gmail keeps its trash 30 days.
    t.clock.advance(8 * DAY);
    const [v] = await undos();
    expect(v).toMatchObject({
      how: "trashed",
      did: "Moved to the trash: Lunch?",
      label: 'Undo: bring "Lunch?" back to the inbox',
      blocked: null,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect(await flags(gid)).toEqual(expect.arrayContaining(["INBOX"]));
    expect(await flags(gid)).not.toContain("TRASH");
    expect(await flags(reply)).toEqual(["SENT"]);
    expect(await thread(id)).toMatchObject({ trashed: false, inInbox: true });
    await sync();
    expect(atGmail(gid)).toContain("INBOX");
    expect(atGmail(reply)).toEqual(["SENT"]);
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });

  it("says Gmail has emptied it after 30 days", async () => {
    const { id } = await lunch();
    await ok("mail.trash", { ids: [id] }, pip());
    t.clock.advance(31 * DAY);
    const [v] = await undos();
    expect(v?.blocked).toBe("Gone for good: Gmail empties its trash after 30 days");
    expect(await press(v!)).toMatchObject({ code: "conflict" });
  });
});

describe("Undo for read and starred", () => {
  it("marks unread again only the messages that were unread", async () => {
    const { gid: read, id } = await lunch(["INBOX", "CATEGORY_PERSONAL"]);
    const unread = g.gmail.deliver({
      from: ANA,
      subject: "Re: Lunch?",
      text: "Or Saturday?",
      messageId: "a2@friends.example",
      inReplyTo: "a1@friends.example",
      references: ["a1@friends.example"],
    });
    await sync();
    await ok("mail.mark_read", { ids: [id] }, pip());
    const [v] = await undos();
    expect(v).toMatchObject({
      did: "Marked read: Lunch?",
      label: 'Undo: mark "Lunch?" unread again',
      blocked: null,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect(await flags(unread)).toContain("UNREAD");
    expect(await flags(read)).not.toContain("UNREAD");
    expect((await thread(id)).unread).toBe(true);
  });

  it("unstars what Pip starred, unless you've unstarred it yourself since", async () => {
    const { id } = await lunch();
    await ok("mail.star", { ids: [id] }, pip());
    const [v] = await undos();
    expect(v).toMatchObject({ did: "Starred: Lunch?", label: 'Undo: unstar "Lunch?"' });
    await ok("mail.star", { ids: [id], starred: false });
    await ok("mail.star", { ids: [id] });
    expect((await undos())[0]).toMatchObject({ blocked: "You've changed it since" });
    expect(await press(v!)).toMatchObject({ code: "conflict" });
    expect((await thread(id)).starred).toBe(true);
  });

  it("is too old after a week", async () => {
    const { id } = await lunch();
    await ok("mail.star", { ids: [id] }, pip());
    t.clock.advance(8 * DAY);
    expect((await undos())[0]?.blocked).toBe("Too old to undo here");
  });

  it("has no Undo for what you did yourself", async () => {
    const { id } = await lunch();
    await ok("mail.archive", { ids: [id] });
    expect(await undos()).toEqual([]);
  });
});
