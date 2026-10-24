// People from Slack, on the fake Slack: someone you've talked with directly becomes a person, by
// their Slack email, and no one else does. Mail and Slack meet in one person, a name you gave
// stays, the trash and desks' addresses are left alone, and what was read in before is looked at
// over the next rounds.
import { randomBytes } from "node:crypto";
import { entity, link, personEmail, slackMessage, slackUser } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { personFor } from "../people/store.ts";
import type { PersonSummary } from "../people/views.ts";
import { SLACK_SERVICE, type SlackUser } from "./api.ts";
import { FakeSlack } from "./fake.ts";

let t: TestKernel;
let s: FakeSlack;

const member = (id: string, name: string, more: Partial<SlackUser> = {}) =>
  s.users.set(id, { id, name, bot: false, teamId: "T1", ...more });

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000) - 3600;
  s.users.set("UME", { id: "UME", name: "Me", email: "me@acme.example", bot: false });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(() => t.destroy());

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () =>
  ok<{ people: number; error?: string }>("slack.sync", {}, integrationCaller("slack"));
const connect = () => ok("slack.connect", { token: s.token });
// Everyone but you (the owner has a person record of their own).
const people = async () =>
  (await ok<PersonSummary[]>("person.list")).filter((p) => p.name !== "You").map((p) => p.name);
const linkedTo = (userId: string) =>
  t.tdb.db.select().from(slackUser).where(eq(slackUser.id, userId));

describe("people from Slack", () => {
  it("makes a person of each one you've talked with directly, and no one else", async () => {
    s.conversations = [
      { id: "C1", name: "general", kind: "channel" },
      { id: "D1", name: "", kind: "dm", user: "UANA" },
      { id: "D2", name: "", kind: "dm", user: "UCAT" },
      { id: "D3", name: "", kind: "dm", user: "UBOT" },
      { id: "D4", name: "", kind: "dm", user: "UGONE" },
      { id: "D5", name: "", kind: "dm", user: "USUP" },
      { id: "G1", name: "mpdm-me--gia--hal", kind: "group" },
    ];
    member("UANA", "ana", {
      realName: "Ana Silva",
      displayName: "ana",
      email: "Ana@Acme.example",
      title: "Designer",
      tz: "America/New_York",
    });
    member("UBOB", "Bob", { email: "bob@acme.example" });
    member("UCAT", "Cat", { email: "cat@acme.example" });
    member("UDAN", "Dan", { email: "dan@acme.example" });
    member("UGIA", "Gia", { email: "gia@acme.example" });
    member("UHAL", "Hal", { email: "hal@acme.example" });
    // Slack Connect: another org's people.
    member("UEVE", "Eve", { email: "eve@partner.example", teamId: "T2" });
    member("UFRED", "Fred", { email: "fred@partner.example", teamId: "T2" });
    member("UBOT", "Deploys", { bot: true });
    member("UGONE", "Gone", { email: "gone@acme.example", deleted: true });
    member("USUP", "Acme Support", { email: "support@acme.example" });

    s.post("D1", "UANA", "Quick question about the mockups"); // a DM from them
    s.post("D2", "UME", "Hi Cat, got a minute?"); // a DM from you
    const start = s.post("C1", "UDAN", "Release notes are up");
    s.post("C1", "UME", "Thanks, reading now", start); // a thread you both wrote in
    s.post("G1", "UME", "Lunch?");
    s.post("G1", "UGIA", "Yes!"); // a group DM you both wrote in; Hal never wrote
    s.post("C1", "UEVE", "<@UME> hello from Partner"); // another org's, to you only
    s.post("C1", "UME", "<@UFRED> thanks for the intro"); // you wrote to another org's
    s.post("C1", "UBOB", "Standup in five"); // only the channel
    s.post("D3", "UBOT", "Deploy finished");
    s.post("D4", "UGONE", "Bye all");
    s.post("D5", "UME", "My invoice is wrong");
    await connect();
    const r = await sync();
    expect(r.error).toBeUndefined();
    expect((await people()).sort()).toEqual(["Ana Silva", "Cat", "Dan", "Fred", "Gia"]);
    expect(r.people).toBe(5);

    // Their Slack email is their address, their profile is kept, and their messages are theirs.
    const [ana] = await linkedTo("UANA");
    expect(ana).toMatchObject({ title: "Designer", timeZone: "America/New_York" });
    expect(ana?.personId).toBe(await personFor(t.tdb.db, "ana@acme.example"));
    const links = await t.tdb.db.select().from(link).where(eq(link.toId, ana!.personId!));
    expect(links).toMatchObject([{ kind: "participant" }]);
    // Their company, from their work address.
    const companies = await ok<{ name: string }[]>("company.list");
    expect(companies.map((c) => c.name)).toEqual(["Acme", "Partner"]);
    // Looked at once.
    const left = await t.tdb.db
      .select()
      .from(slackMessage)
      .where(eq(slackMessage.peopleLinked, false));
    expect(left).toEqual([]);
    expect((await sync()).people).toBe(0);
  });

  it("meets mail's person by email, keeps your name for them, and leaves the trash and desks alone", async () => {
    const ana = await ok<{ id: string }>("person.create", { name: "Ana S." });
    await ok("person.add_email", { id: ana.id, email: "ana@acme.example" });
    const tom = await ok<{ id: string }>("person.create", { name: "Tom" });
    await ok("person.add_email", { id: tom.id, email: "tom@acme.example" });
    await ok("entity.trash", { id: tom.id });
    s.conversations = [
      { id: "D1", name: "", kind: "dm", user: "UANA" },
      { id: "D2", name: "", kind: "dm", user: "UTOM" },
      { id: "D3", name: "", kind: "dm", user: "UNOREPLY" },
    ];
    member("UANA", "Ana Silva", { email: "ana@acme.example" });
    member("UTOM", "Tom Ray", { email: "tom@acme.example" });
    member("UNOREPLY", "Notifications", { email: "no-reply@acme.example" });
    const said = s.post("D1", "UANA", "Here are the files");
    s.post("D1", "UME", "Thanks!");
    s.post("D2", "UME", "Are you around?");
    s.post("D3", "UME", "Unsubscribe");
    await connect();
    await sync();

    // One Ana, still named as you named her, with her Slack messages.
    expect(await people()).toEqual(["Ana S."]);
    expect((await linkedTo("UANA"))[0]?.personId).toBe(ana.id);
    const [msg] = await t.tdb.db.select().from(slackMessage).where(eq(slackMessage.ts, said));
    const theirs = await t.tdb.db
      .select()
      .from(link)
      .where(and(eq(link.fromId, msg!.entityId), eq(link.toId, ana.id)));
    expect(theirs).toHaveLength(1);
    // Tom stays in the trash, and his address stays his.
    expect((await linkedTo("UTOM"))[0]?.personId).toBeNull();
    const [gone] = await t.tdb.db.select().from(entity).where(eq(entity.id, tom.id));
    expect(gone?.deletedAt).not.toBeNull();
    expect(
      await t.tdb.db.select().from(personEmail).where(eq(personEmail.address, "tom@acme.example")),
    ).toMatchObject([{ personId: tom.id }]);
    // A desk's address is no one.
    expect(await personFor(t.tdb.db, "no-reply@acme.example")).toBeNull();
  });

  it("looks at what was read in before, a round's lookups at a time", async () => {
    s.conversations = Array.from({ length: 20 }, (_, i) => ({
      id: `D${i}`,
      name: "",
      kind: "dm" as const,
      user: `U${i}`,
    }));
    for (let i = 0; i < 20; i++) {
      member(`U${i}`, `Person ${String(i).padStart(2, "0")}`, { email: `p${i}@acme.example` });
      s.post(`D${i}`, `U${i}`, "Hello");
    }
    await connect();
    // Slack's lookups are spread over rounds: 15 this one, the rest the next.
    expect((await sync()).people).toBe(15);
    expect((await sync()).people).toBe(5);
    expect(await people()).toHaveLength(20);

    // As if read in before people came from Slack: not looked at yet, and no one made.
    const made = await t.tdb.db
      .select({ id: entity.id })
      .from(entity)
      .where(and(eq(entity.type, "person"), eq(entity.createdBy, "integration:slack")));
    for (const p of made) await t.tdb.db.delete(entity).where(eq(entity.id, p.id));
    await t.tdb.db.update(slackMessage).set({ peopleLinked: false, mentions: null });
    expect(await people()).toEqual([]);
    expect((await sync()).people).toBe(20);
    expect(await people()).toHaveLength(20);
    const unlinked = await t.tdb.db.select().from(slackUser).where(isNull(slackUser.personId));
    expect(unlinked).toEqual([]);
  });
});
