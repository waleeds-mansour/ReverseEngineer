// A persona end to end: someone you talk with on Slack becomes a person, the morning routine has
// Pip write a few lines about them on Haiku (D82), and reading them afterwards is reading outside
// content (D58), even for someone you added yourself.
import { randomBytes } from "node:crypto";
import { person } from "@hearth/db";
import { type Caller, integrationCaller, ownerCaller } from "@hearth/kernel";
import { FakeSlack, SLACK_SERVICE, VAULT_SERVICE, Vault } from "@hearth/modules";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";
import { readRecord } from "./tools.ts";

let h: JarvisHarness;
let s: FakeSlack;

async function ok<T>(name: string, input: unknown = {}, caller: Caller = ownerCaller()) {
  const res = await h.kernel.execute<T>(name, input, caller);
  if (res.status !== "ok") throw new Error(`${name}: ${JSON.stringify(res)}`);
  return res.result;
}

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thursday 10 a.m.
  s = new FakeSlack();
  s.clock = Math.floor(h.clock.now().getTime() / 1000) - 3600;
  s.conversations = [{ id: "D1", name: "", kind: "dm", user: "UANA" }];
  s.users.set("UANA", {
    id: "UANA",
    name: "Ana Silva",
    email: "ana@acme.example",
    bot: false,
    title: "Designer",
  });
  h.kernel.services[SLACK_SERVICE] = s.api();
  h.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
});
afterEach(() => h.destroy());

describe("personas", () => {
  it("are written each morning on Haiku, and read as outside content afterwards", async () => {
    const ana = await ok<{ id: string }>("person.create", { name: "Ana" });
    await ok("person.add_email", { id: ana.id, email: "ana@acme.example" });
    expect((await readRecord(h.kernel, ana.id))?.fromOutside).toBe(false);

    for (let i = 0; i < 8; i++)
      s.post("D1", i % 2 ? "UME" : "UANA", `Can you check the launch page copy? (${i})`);
    await ok("slack.connect", { token: s.token });
    await ok("slack.sync", {}, integrationCaller("slack"));
    await h.settle();

    h.brain.otherwise((req) =>
      req.prompt.startsWith("Personas")
        ? [
            {
              call: "person_write_persona",
              input: {
                id: ana.id,
                persona: "Ana writes the launch page copy and asks you to check it.",
              },
            },
            { say: "Done." },
          ]
        : [{ say: "OK." }],
    );
    h.clock.set("2026-10-02T09:40:10Z"); // 5:40 a.m.
    await h.settle();

    const asked = h.brain.requests.filter((r) => r.prompt.startsWith("Personas"));
    expect(asked).toHaveLength(1);
    expect(asked[0]?.model).toMatchObject({ job: "personas", tier: "haiku" });
    expect(asked[0]?.prompt).toContain('<untrusted source="slack">');
    const [row] = await h.tdb.db.select().from(person).where(eq(person.entityId, ana.id));
    expect(row?.persona).toBe("Ana writes the launch page copy and asks you to check it.");

    const read = await readRecord(h.kernel, ana.id);
    expect(read?.fromOutside).toBe(true);
    expect(read?.text).toMatch(/^<untrusted[\s\S]*Ana writes the launch page copy/);
  });
});
