// Undo for how Pip sorted your mail on its own (the owner, 2026-10-27): a conversation it moved to
// another bundle goes back, a sender it sent to Signal or Noise goes back with their rule as it
// was, and a draft it threw away comes back. Greyed once you've changed it since; never sends.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { entity, event, mailMessage, mailSenderRule, mailThread } from "@hearth/db";
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
  expect(g.gmail.sent).toHaveLength(0);
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const pip = () => jarvisCaller("untrusted", { correlationId: newId(), mode: "proactive" });
const undos = () => ok<UndoView[]>("activity.undos", { since: "2026-09-30T00:00:00Z" });
const press = (v: UndoView) => t.kernel.execute("activity.undo", { ref: v.ref }, ownerCaller());
const thread = async (id: string) =>
  (await t.tdb.db.select().from(mailThread).where(eq(mailThread.entityId, id)))[0]!;
const rules = () => t.tdb.db.select().from(mailSenderRule);

/** Ana's "Lunch?": in the inbox, in Signal and People. */
async function lunch() {
  const gid = g.gmail.deliver({ from: ANA, subject: "Lunch?", text: "Friday?" });
  await ok("mail.sync", {}, integrationCaller("google"));
  const [m] = await t.tdb.db.select().from(mailMessage).where(eq(mailMessage.providerId, gid));
  return m!.threadId;
}

describe("Undo for a conversation Pip moved to another bundle", () => {
  it("puts it back, sorted by the rules again as it was", async () => {
    const id = await lunch();
    expect(await thread(id)).toMatchObject({ bundle: "people", bundleMoved: false });
    await ok("mail.set_bundle", { threadId: id, bundle: "updates" }, pip());
    const [v] = await undos();
    expect(v).toMatchObject({
      how: "changed",
      did: "Moved to Updates: Lunch?",
      label: 'Undo: move "Lunch?" back to People',
      blocked: null,
      entityId: id,
      outside: true,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect(await thread(id)).toMatchObject({ bundle: "people", bundleMoved: false });
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });

  it("is greyed and refused once you've moved it yourself", async () => {
    const id = await lunch();
    await ok("mail.set_bundle", { threadId: id, bundle: "updates" }, pip());
    await ok("mail.set_bundle", { threadId: id, bundle: "receipts" });
    const [v] = await undos();
    expect(v).toMatchObject({ blocked: "You've changed it since" });
    expect(await press(v!)).toMatchObject({ code: "conflict" });
    expect((await thread(id)).bundle).toBe("receipts");
  });
});

describe("Undo for a sender Pip sent to Signal or Noise", () => {
  it("forgets the rule it made and moves their conversations back", async () => {
    const id = await lunch();
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" }, pip());
    expect((await thread(id)).lane).toBe("noise");
    const [v] = await undos();
    expect(v).toMatchObject({
      how: "changed",
      did: "Sent mail from friends.example to Noise",
      label:
        'Undo: forget the Noise rule for "friends.example" and move its conversation back to Signal',
      blocked: null,
      entityId: null,
      outside: true,
    });
    await ok("activity.undo", { ref: v!.ref });
    expect(await rules()).toEqual([]);
    expect((await thread(id)).lane).toBe("signal");
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });

  it("puts back the rule you had before", async () => {
    await lunch();
    await ok("mail.set_lane", { sender: "friends.example", lane: "signal" });
    t.clock.advance(60_000);
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" }, pip());
    const [v] = await undos();
    expect(v?.label).toBe('Undo: send mail from "friends.example" back to Signal');
    await ok("activity.undo", { ref: v!.ref });
    expect(await rules()).toMatchObject([{ pattern: "friends.example", lane: "signal" }]);
  });

  it("stays good when the same lane is set again, which changes nothing", async () => {
    const id = await lunch();
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" }, pip());
    t.clock.advance(60_000);
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" }, pip());
    t.clock.advance(60_000);
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" });
    const [v, ...rest] = await undos();
    expect(rest).toEqual([]);
    expect(v).toMatchObject({ blocked: null });
    await ok("activity.undo", { ref: v!.ref });
    expect(await rules()).toEqual([]);
    expect((await thread(id)).lane).toBe("signal");
  });

  it("leaves where it is a conversation another of your rules keeps there", async () => {
    const id = await lunch();
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" }, pip());
    // Since, you've sent Ana herself to Noise.
    await ok("mail.set_lane", { sender: "ana@friends.example", lane: "noise" });
    const [v] = await undos();
    expect(v).toMatchObject({ blocked: null });
    await ok("activity.undo", { ref: v!.ref });
    expect(await rules()).toMatchObject([{ pattern: "ana@friends.example", lane: "noise" }]);
    expect((await thread(id)).lane).toBe("noise");
  });

  it("puts it back once when two tabs press it at the same time", async () => {
    const id = await lunch();
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" }, pip());
    const [v] = await undos();
    const both = await Promise.all([press(v!), press(v!)]);
    expect(both.map((r) => r.status).sort()).toEqual(["error", "ok"]);
    expect(both.find((r) => r.status === "error")).toMatchObject({ code: "conflict" });
    const undone = await t.tdb.db.select().from(event).where(eq(event.kind, "activity.undone"));
    expect(undone).toHaveLength(1);
    expect((await thread(id)).lane).toBe("signal");
  });

  it("is greyed once you've forgotten the rule yourself", async () => {
    await lunch();
    await ok("mail.set_lane", { sender: "friends.example", lane: "noise" }, pip());
    await ok("mail.remove_rule", { pattern: "friends.example" });
    const [v] = await undos();
    expect(v).toMatchObject({ blocked: "You've changed it since" });
    expect(await press(v!)).toMatchObject({ code: "conflict" });
  });
});

describe("Undo for a draft Pip threw away", () => {
  it("brings it back, still unsent", async () => {
    const id = await lunch();
    const d = await ok<{ id: string }>(
      "mail.draft",
      { threadId: id, text: "Friday works." },
      pip(),
    );
    await ok("mail.discard", { id: d.id }, pip());
    const [v] = await undos();
    expect(v).toMatchObject({
      how: "trashed",
      did: "Threw away a draft: Re: Lunch?",
      label: 'Undo: bring back the draft "Re: Lunch?"',
      blocked: null,
      entityId: d.id,
      entityType: "email_draft",
    });
    await ok("activity.undo", { ref: v!.ref });
    const [row] = await t.tdb.db.select().from(entity).where(eq(entity.id, d.id));
    expect(row!.deletedAt).toBeNull();
    expect(await ok<{ id: string }[]>("mail.drafts", { threadId: id })).toMatchObject([
      { id: d.id },
    ]);
    expect((await undos())[0]).toMatchObject({ blocked: "Undone", undone: true });
  });
});
