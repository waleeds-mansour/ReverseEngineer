// Personas: what's due (enough talk, at most weekly, sooner after a lot of it), what Pip is given
// to write from (your Slack talk, as other people's words), and how the person page and Jarvis
// read one: in its own field, marked as outside content (D58), your notes untouched.
import { randomBytes } from "node:crypto";
import { entity } from "@hearth/db";
import {
  type Caller,
  type HearthEvent,
  integrationCaller,
  jarvisCaller,
  ownerCaller,
} from "@hearth/kernel";
import { createTestKernel, type TestKernel } from "@hearth/kernel/testing";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VAULT_SERVICE, Vault } from "../browser/vault.ts";
import { ALL_MODULES } from "../index.ts";
import { SLACK_SERVICE } from "../slack/api.ts";
import { FakeSlack } from "../slack/fake.ts";
import { LOTS, MIN_TALK, personaRoutine, personasDue } from "./persona.ts";
import type { PersonView } from "./views.ts";

const DAY = 86_400_000;
let t: TestKernel;
let s: FakeSlack;
let ana: string;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await t.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}
const sync = () => ok("slack.sync", {}, integrationCaller("slack"));
const due = async () => (await personasDue(t.tdb.db, t.clock.now())).map((d) => d.id);
const view = () => ok<PersonView>("person.view", { id: ana });
/** Slack's clock follows Hearth's, so new messages are new to it. */
const talk = (n: number, from = "UANA") => {
  s.clock = Math.max(s.clock, Math.floor(t.clock.now().getTime() / 1000) - 60);
  for (let i = 0; i < n; i++) s.post("D1", i % 2 ? "UME" : from, `About the launch, part ${i}`);
};
const run = () =>
  personaRoutine.run(
    { scheduledFor: t.clock.now(), event: {} as HearthEvent, digest: async () => [] },
    { db: t.tdb.db, now: t.clock.now() },
  );

beforeEach(async () => {
  t = await createTestKernel(ALL_MODULES);
  s = new FakeSlack();
  s.clock = Math.floor(t.clock.now().getTime() / 1000) - 3600;
  s.conversations = [
    { id: "C1", name: "general", kind: "channel" },
    { id: "D1", name: "", kind: "dm", user: "UANA" },
  ];
  s.users.set("UANA", {
    id: "UANA",
    name: "ana",
    realName: "Ana Silva",
    displayName: "ana",
    email: "ana@acme.example",
    bot: false,
    title: "Designer",
    tz: "America/New_York",
  });
  t.kernel.services[SLACK_SERVICE] = s.api();
  t.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
  // You know Ana already, with notes of your own.
  ana = (await ok<{ id: string }>("person.create", { name: "Ana", notes: "Met at the offsite." }))
    .id;
  await ok("person.add_email", { id: ana, email: "ana@acme.example" });
  await ok("slack.connect", { token: s.token });
});
afterEach(() => t.destroy());

describe("personas", () => {
  it("are due once there's enough talk with you, not their talk with everyone", async () => {
    talk(2);
    for (let i = 0; i < 20; i++) s.post("C1", "UANA", `Channel news ${i}`);
    await sync();
    expect(await due()).toEqual([]);
    talk(MIN_TALK);
    await sync();
    expect(await due()).toEqual([ana]);
  });

  it("give Pip your talk as other people's words, on its own turn", async () => {
    talk(MIN_TALK);
    await sync();
    const [turn] = await run();
    expect(turn).toMatchObject({
      kind: "turn",
      trigger: "routine",
      untrusted: true,
      context: { routine: "personas", people: 1 },
    });
    const prompt = turn?.kind === "turn" ? turn.prompt : "";
    expect(prompt).toContain(`## person ${ana}`);
    expect(prompt).toMatch(
      /<untrusted source="slack">\nAna \(Slack: ana · Designer · America\/New_York\)\n[\s\S]*them in a direct message: About the launch, part 0/,
    );
    expect(prompt).toContain("the owner in a direct message: About the launch, part 1");
    expect(prompt).toContain("person_write_persona");
  });

  it("are written by Pip into their own field, read as outside content, and refreshed at most weekly", async () => {
    talk(MIN_TALK);
    await sync();
    // Only Pip writes one; your notes stay as they are.
    const owner = await t.kernel.execute(
      "person.write_persona",
      { id: ana, persona: "x" },
      ownerCaller(),
    );
    expect(owner.status).toBe("denied");
    await ok(
      "person.write_persona",
      { id: ana, persona: "Ana designs the launch pages with you; you trade quick DMs." },
      jarvisCaller("untrusted"),
    );
    const v = await view();
    expect(v.notes).toBe("Met at the offsite.");
    expect(v.persona).toMatchObject({
      text: "Ana designs the launch pages with you; you trade quick DMs.",
      outside: true,
    });
    expect(v.slack).toMatchObject({ title: "Designer", timeZone: "America/New_York" });

    // What Jarvis reads of her says it's her words.
    const read = await t.kernel.registry.describer("person")!(ana, {
      db: t.tdb.db,
      now: t.clock.now(),
    });
    expect(read).toMatchObject({ outside: true });
    const text = typeof read === "object" && read ? read.text : "";
    expect(text).toContain("Met at the offsite.");
    expect(text).toContain("Slack: @ana, Designer, time zone America/New_York");
    expect(text).toContain(
      "Persona (Pip's, from your Slack talk, 2026-10-01 10 a.m.): Ana designs the launch pages",
    );

    // Not again this week, after a little new talk; a week on, yes.
    expect(await due()).toEqual([]);
    t.clock.advance(3 * DAY);
    talk(2);
    await sync();
    expect(await due()).toEqual([]);
    t.clock.advance(5 * DAY);
    expect(await due()).toEqual([ana]);
  });

  it("are written again early after a lot of new talk", async () => {
    talk(MIN_TALK);
    await sync();
    await ok(
      "person.write_persona",
      { id: ana, persona: "Ana works on launch." },
      jarvisCaller("agent"),
    );
    t.clock.advance(DAY);
    talk(LOTS);
    await sync();
    expect(await due()).toEqual([ana]);
  });

  it("aren't kept for someone in the trash", async () => {
    talk(MIN_TALK);
    await sync();
    await ok("entity.trash", { id: ana });
    expect(await due()).toEqual([]);
    const res = await t.kernel.execute(
      "person.write_persona",
      { id: ana, persona: "Gone." },
      jarvisCaller("agent"),
    );
    expect(res).toMatchObject({ status: "error", code: "not_found" });
    const [row] = await t.tdb.db.select().from(entity).where(eq(entity.id, ana));
    expect(row?.deletedAt).not.toBeNull();
  });
});
