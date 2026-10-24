// Mail and Slack meet in one person, by address, whichever came first: someone you wrote to by
// email is the same person when you talk on Slack, and someone Slack made a person gets their mail.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { link, mailMessage, slackUser } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { GOOGLE_SERVICE, SCOPES } from "../google/client.ts";
import { FakeGoogle } from "../google/fake.ts";
import { ALL_MODULES } from "../index.ts";
import { BLOB_SERVICE, BlobStore } from "../mail/blobs.ts";
import { personFor } from "../people/store.ts";
import type { PersonSummary } from "../people/views.ts";
import { SLACK_SERVICE } from "./api.ts";
import { FakeSlack } from "./fake.ts";

const ME = "owner@acme.example";
let t: TestKernel;
let g: FakeGoogle;
let s: FakeSlack;
let dir: string;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const mail = () => ok("mail.sync", {}, integrationCaller("google"));
const slack = () => ok("slack.sync", {}, integrationCaller("slack"));
const people = async () =>
  (await ok<PersonSummary[]>("person.list")).filter((p) => p.name !== "You").map((p) => p.name);

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  g = new FakeGoogle(ME);
  g.grants = ["openid", "email", ...SCOPES.calendar, ...SCOPES.gmail];
  t.kernel.services[GOOGLE_SERVICE] = g.client();
  dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
  t.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
  const client = g.client();
  const url = new URL(await client.startSignIn(t.tdb.db, [...SCOPES.calendar, ...SCOPES.gmail]));
  await client.finishSignIn(t.tdb.db, url.searchParams.get("state")!, "the-code");
  s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000) - 3600;
  s.conversations = [
    { id: "D1", name: "", kind: "dm", user: "UANA" },
    { id: "D2", name: "", kind: "dm", user: "UCAT" },
  ];
  s.users.set("UME", { id: "UME", name: "Me", email: ME, bot: false });
  s.users.set("UANA", {
    id: "UANA",
    name: "ana",
    realName: "Ana S",
    email: "ana@acme.example",
    bot: false,
  });
  s.users.set("UCAT", { id: "UCAT", name: "Cat Lee", email: "cat@acme.example", bot: false });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

describe("people from mail and Slack", () => {
  it("are one person, whichever came first", async () => {
    // Mail first: you wrote to Ana, so she's a person, named as her address says.
    g.gmail.deliver(
      {
        from: { address: ME },
        to: [{ address: "ana@acme.example", name: "Ana Silva" }],
        subject: "Hello",
        text: "Hi",
      },
      ["SENT"],
    );
    await mail();
    expect(await people()).toEqual(["Ana Silva"]);
    const ana = await personFor(t.tdb.db, "ana@acme.example");

    // Slack: you talk with Ana and Cat. Ana is the same person, and keeps her name.
    s.post("D1", "UANA", "Saw your email");
    s.post("D2", "UME", "Hi Cat");
    await ok("slack.connect", { token: s.token });
    await slack();
    expect(await people()).toEqual(["Ana Silva", "Cat Lee"]);
    const [u] = await t.tdb.db.select().from(slackUser).where(eq(slackUser.id, "UANA"));
    expect(u?.personId).toBe(ana);

    // Slack first: Cat's mail is hers.
    g.gmail.deliver({
      from: { address: "cat@acme.example", name: "Cat" },
      to: [{ address: ME }],
      subject: "Lunch",
      text: "Friday?",
    });
    await mail();
    const cat = await personFor(t.tdb.db, "cat@acme.example");
    const [email] = await t.tdb.db
      .select({ id: mailMessage.entityId })
      .from(mailMessage)
      .where(eq(mailMessage.fromAddress, "cat@acme.example"));
    const linked = await t.tdb.db
      .select()
      .from(link)
      .where(and(eq(link.fromId, email!.id), eq(link.toId, cat!)));
    expect(linked).toMatchObject([{ kind: "participant" }]);
    expect(await people()).toEqual(["Ana Silva", "Cat Lee"]);
  });
});
