// Undo for a triage of Pip's (the owner, 2026-10-27): many conversations done the same way in one
// go are one line on Today with one Undo, which puts back only those still as Pip left them and
// says how many it leaves. And Undo for a move back to the inbox, and for "needs no reply".
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { event, mailMessage, mailThread } from "@hearth/db";
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
/** Pip, triaging on its own after mail came in: one call. */
const pip = () => jarvisCaller("untrusted", { correlationId: newId(), mode: "proactive" });
const sync = () => ok("mail.sync", {}, integrationCaller("google"));
const undos = () => ok<UndoView[]>("activity.undos", { since: "2026-09-30T00:00:00Z" });
const thread = async (id: string) =>
  (await t.tdb.db.select().from(mailThread).where(eq(mailThread.entityId, id)))[0]!;
const threadOf = async (gid: string) =>
  (await t.tdb.db.select().from(mailMessage).where(eq(mailMessage.providerId, gid)))[0]!.threadId;

/** Conversations from different people, each in the inbox, by their ids. */
async function inbox(subjects: string[]) {
  const gids = subjects.map((subject, i) =>
    g.gmail.deliver({
      from: { address: `p${i}@friends.example`, name: `P${i}` },
      subject,
      text: "Hi",
      messageId: `m${i}@friends.example`,
    }),
  );
  await sync();
  return Promise.all(gids.map(threadOf));
}

describe("Undo for many conversations done the same way in one go", () => {
  it("is one line, and puts back only those still as Pip left them", async () => {
    const ids = await inbox(["Lunch?", "Invoice", "Tickets"]);
    await ok("mail.archive", { ids }, pip());
    const [v, ...rest] = await undos();
    expect(rest).toEqual([]);
    expect(v).toMatchObject({
      how: "changed",
      did: "Archived 3 conversations",
      label: "Undo: put the 3 conversations back in the inbox",
      blocked: null,
      entityId: null,
      entityType: "email_thread",
      outside: false,
    });
    // You bring one back and archive it again yourself.
    await ok("mail.unarchive", { ids: [ids[0]] });
    await ok("mail.archive", { ids: [ids[0]] });
    const [w] = await undos();
    expect(w).toMatchObject({
      label: "Undo: put 2 of the 3 conversations back in the inbox; 1 changed since stays as it is",
      blocked: null,
    });
    // One press for all of them: the one you changed stays as you left it.
    await ok("activity.undo", { ref: w!.ref });
    expect((await thread(ids[0]!)).inInbox).toBe(false);
    expect((await thread(ids[1]!)).inInbox).toBe(true);
    expect((await thread(ids[2]!)).inInbox).toBe(true);
    expect(await undos()).toMatchObject([{ blocked: "Undone", undone: true }]);
    const undone = await t.tdb.db.select().from(event).where(eq(event.kind, "activity.undone"));
    expect(undone).toHaveLength(1);
    expect(undone[0]!.payload).toMatchObject({ ref: w!.ref, did: "Archived 3 conversations" });
  });

  it("is greyed once you've changed every one of them", async () => {
    const ids = await inbox(["Lunch?", "Invoice"]);
    await ok("mail.star", { ids }, pip());
    await ok("mail.star", { ids, starred: false });
    const [v] = await undos();
    expect(v).toMatchObject({ did: "Starred 2 conversations", blocked: "You've changed it since" });
    expect(await t.kernel.execute("activity.undo", { ref: v!.ref }, ownerCaller())).toMatchObject({
      code: "conflict",
    });
  });

  it("keeps separate calls, and different changes, on lines of their own", async () => {
    const ids = await inbox(["Lunch?", "Invoice"]);
    const turn = pip();
    await ok("mail.archive", { ids: [ids[0]] }, turn);
    await ok("mail.mark_read", { ids }, turn);
    await ok("mail.star", { ids: [ids[1]] }, pip());
    const did = (await undos()).map((v) => v.did).sort();
    expect(did).toEqual(["Archived: Lunch?", "Marked 2 conversations read", "Starred: Invoice"]);
  });
});

describe("Undo for a move back to the inbox", () => {
  it("takes it out again, and back to the trash what was there", async () => {
    const [archived, trashed] = await inbox(["Lunch?", "Invoice"]);
    await ok("mail.archive", { ids: [archived] });
    await ok("mail.trash", { ids: [trashed] });
    await ok("mail.unarchive", { ids: [archived] }, pip());
    await ok("mail.unarchive", { ids: [trashed] }, pip());
    const vs = await undos();
    const out = vs.find((v) => v.entityId === archived)!;
    const back = vs.find((v) => v.entityId === trashed)!;
    expect(out).toMatchObject({
      did: "Moved back to the inbox: Lunch?",
      label: 'Undo: take "Lunch?" out of the inbox again',
      blocked: null,
    });
    expect(back.label).toBe('Undo: put "Invoice" back in the trash');
    await ok("activity.undo", { ref: out.ref });
    await ok("activity.undo", { ref: back.ref });
    expect(await thread(archived!)).toMatchObject({ inInbox: false, trashed: false });
    expect(await thread(trashed!)).toMatchObject({ inInbox: false, trashed: true });
  });
});

describe("Undo for needs no reply", () => {
  it("puts it back as needing your reply", async () => {
    const [id] = await inbox(["Lunch?"]);
    const waiting = (await thread(id!)).waiting;
    await ok("mail.no_reply", { ids: [id] }, pip());
    const [v] = await undos();
    expect(v).toMatchObject({
      did: "Said it needs no reply: Lunch?",
      label: 'Undo: put "Lunch?" back as needing your reply',
      blocked: null,
      entityId: id,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect(await thread(id!)).toMatchObject({ noReplyCount: null, waiting });
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });

  it("is greyed once a new message comes, and has none when it already needed none", async () => {
    const gid = g.gmail.deliver({
      from: ANA,
      subject: "Lunch?",
      text: "Friday?",
      messageId: "a1@x",
    });
    await sync();
    const id = await threadOf(gid);
    await ok("mail.no_reply", { ids: [id] }, pip());
    await ok("mail.no_reply", { ids: [id] }, pip());
    expect(await undos()).toHaveLength(1);
    g.gmail.deliver({
      from: ANA,
      subject: "Re: Lunch?",
      text: "Or Saturday?",
      messageId: "a2@x",
      inReplyTo: "a1@x",
      references: ["a1@x"],
    });
    await sync();
    expect((await undos())[0]).toMatchObject({ blocked: "It's changed since" });
  });
});
