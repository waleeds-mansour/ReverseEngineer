// Who answers Pip's questions, and how far an answer is trusted (D85, D58, D84). Yours, given in
// Nook or at the desktop's desk, picks the work up as trusted as the question was; another
// device's is outside content, its words and the work after them. Outside content can't fill the
// inbox with questions; a question's card leaves only by answering it; inbox_notify can't make a
// question's card or a finished one; and an answer never stands in for an approval.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approval, jarvisTurn, notification, question, schedule } from "@hearth/db";
import { type Caller, integrationCaller, jarvisCaller, newId, ownerCaller } from "@hearth/kernel";
import {
  BLOB_SERVICE,
  BlobStore,
  GOOGLE_SERVICE,
  SCOPES,
  VAULT_SERVICE,
  Vault,
} from "@hearth/modules";
import { FakeGoogle } from "@hearth/modules/google-testing";
import { asc, eq, like } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Script, ScriptStep } from "./brains/scripted.ts";
import { createJarvisHarness, type JarvisHarness } from "./testing.ts";

let h: JarvisHarness;

beforeEach(async () => {
  h = await createJarvisHarness("2026-10-01T14:00:00Z"); // Thu 10 a.m. ET
  await h.tdb.db.delete(schedule).where(like(schedule.id, "routine:%"));
});
afterEach(() => h.destroy());

const ASK: ScriptStep = {
  call: "ask_owner",
  input: {
    question: "Call Ana today?",
    choices: ["Yes", "Later"],
    why: "She asked for a call this week.",
  },
};
const MAKE_TASK: ScriptStep = { call: "task_create", input: { title: "Call Ana" } };
/** The desktop app's token, and the same with its desk open (Windows Hello, D84). */
const DEVICE = ownerCaller("device", { origin: "untrusted" });
const DESK: Caller = { ...DEVICE, desk: true };

const questions = () => h.tdb.db.select().from(question).orderBy(asc(question.createdAt));
const turns = () => h.tdb.db.select().from(jarvisTurn).orderBy(asc(jarvisTurn.queuedAt));
const cards = (kind: string) =>
  h.tdb.db
    .select()
    .from(notification)
    .where(eq(notification.kind, kind))
    .orderBy(asc(notification.createdAt));

/** A turn of Pip's own, as trusted as `origin`, that asks you something. */
async function ownAsk(
  origin: "system" | "untrusted" = "system",
  script: Script | ScriptStep[] = [ASK, { say: "Asked." }],
) {
  h.brain.next(script);
  h.clock.advance(1000);
  const now = h.clock.now();
  await h.tdb.db.insert(jarvisTurn).values({
    id: newId(),
    trigger: "reflex",
    mode: "proactive",
    lane: "fast",
    origin,
    prompt: "Look at what came in.",
    queuedAt: now,
    notBefore: now,
  });
  await h.settle();
  return (await questions()).at(-1)!;
}

describe("answering Pip's questions", () => {
  it("trusts your answer from the desk as the question, and another device's as outside content", async () => {
    const q = await ownAsk();
    // Why Pip asks shows under the choices.
    expect((await cards("question"))[0]!.body).toBe(
      "1. Yes · 2. Later\nShe asked for a call this week.",
    );
    const words = { id: q.id, choice: 0, text: "and say hi" };
    expect((await h.kernel.execute("question.answer", words, DESK)).status).toBe("ok");
    h.brain.next([MAKE_TASK, { say: "Made a task to call Ana today." }]);
    await h.settle();
    const resumed = (await turns()).at(-1)!;
    expect(resumed).toMatchObject({ trigger: "approval", origin: "system" });
    expect(resumed.prompt).toContain("in their own words: and say hi");
    // So the card for the work it finished isn't marked as outside content's.
    expect(await cards("finished")).toMatchObject([
      { title: "Pip finished what you decided", outside: false },
    ]);

    const again = await ownAsk();
    const sent = await h.kernel.execute("question.answer", { ...words, id: again.id }, DEVICE);
    expect(sent.status).toBe("ok");
    h.brain.next([MAKE_TASK, { say: "Made another task." }]);
    await h.settle();
    const after = (await turns()).at(-1)!;
    expect(after.origin).toBe("untrusted");
    expect(after.prompt).toContain('<untrusted source="answer">');
    // Its card joined the unseen one, and now carries words a device sent.
    expect(await cards("finished")).toMatchObject([
      {
        title: "Pip finished 2 things: what you decided",
        body: "Made another task.",
        outside: true,
      },
    ]);
  });

  it("keeps a question's card until it's answered", async () => {
    const q = await ownAsk();
    const [card] = await cards("question");
    const owner = ownerCaller();
    expect(
      await h.kernel.execute("inbox.mark", { ids: [card!.id], state: "done" }, owner),
    ).toMatchObject({ status: "ok", result: { updated: 0 } });
    const until = "2026-10-02T14:00:00Z";
    expect(await h.kernel.execute("inbox.snooze", { id: card!.id, until }, owner)).toEqual({
      status: "error",
      code: "conflict",
      message: "This one needs an answer first.",
    });
    expect(
      await h.kernel.execute("inbox.mark", { ids: [card!.id], state: "seen" }, owner),
    ).toMatchObject({ result: { updated: 1 } });
    await h.kernel.execute("question.answer", { id: q.id, choice: 1 }, owner);
    expect((await cards("question"))[0]!.state).toBe("done");
  });

  it("can't be made through inbox_notify, nor finished-work cards", async () => {
    const pip = jarvisCaller("owner", { turnId: newId() });
    for (const kind of ["question", "finished"]) {
      const told = await h.kernel.execute("inbox.notify", { title: "Pick one", kind }, pip);
      expect(told).toMatchObject({ status: "error", code: "invalid_input" });
      expect(await cards(kind)).toEqual([]);
    }
  });
});

describe("how many questions wait", () => {
  it("holds three from turns that read outside content, and eight in all", async () => {
    let said: string[] = [];
    const counted = (out: string[]) => {
      said = out;
      return [ASK, { say: "Asked." }];
    };
    for (let i = 0; i < 3; i++) await ownAsk("untrusted");
    await ownAsk("untrusted", (_req, out) => counted(out));
    expect(said[0]).toContain("ask this in your reply instead");
    expect(await questions()).toHaveLength(3);

    for (let i = 0; i < 5; i++) await ownAsk("system");
    expect(await questions()).toHaveLength(8);
    said = [];
    await ownAsk("system", (_req, out) => counted(out));
    expect(said[0]).toContain("ask this in your reply instead");
    expect(await questions()).toHaveLength(8);
    expect(await cards("question")).toHaveLength(8);
  });
});

describe("an answer and an approval", () => {
  const ME = "owner@example.com";
  let g: FakeGoogle;
  let dir: string;
  let draftId: string;

  beforeEach(async () => {
    g = new FakeGoogle(ME);
    g.clock = h.clock;
    g.grants = ["openid", "email", ...SCOPES.gmail];
    h.kernel.services[GOOGLE_SERVICE] = g.client();
    dir = await mkdtemp(join(tmpdir(), "hearth-blobs-"));
    h.kernel.services[BLOB_SERVICE] = new BlobStore(dir);
    h.kernel.services[VAULT_SERVICE] = new Vault(randomBytes(32));
    const client = g.client();
    const url = new URL(await client.startSignIn(h.tdb.db, [...SCOPES.gmail]));
    await client.finishSignIn(h.tdb.db, url.searchParams.get("state")!, "the-code");
    await h.kernel.execute("mail.sync", {}, integrationCaller("google"));
    const draft = await h.kernel.execute<{ id: string }>(
      "mail.draft",
      { to: ["ana@example.com"], subject: "Lease", text: "Here's the signed lease." },
      ownerCaller(),
    );
    if (draft.status !== "ok") throw new Error(JSON.stringify(draft));
    draftId = draft.result.id;
    await h.settle();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("never stands in for one: a send after your answer still asks", async () => {
    const send: ScriptStep = {
      call: "ask_owner",
      input: { question: "Send Ana the lease now?", choices: ["Send it", "Wait"] },
    };
    h.brain.next([send, { say: "Asked whether to send it." }]);
    const chat = await h.kernel.execute("chat.send", { text: "the lease for Ana" }, ownerCaller());
    expect(chat.status).toBe("ok");
    await h.settle();
    const [q] = await questions();
    await h.kernel.execute("question.answer", { id: q!.id, choice: 0 }, ownerCaller());
    let said: string[] = [];
    h.brain.next((_req, out) => {
      said = out;
      return [{ call: "mail_send", input: { id: draftId } }, { say: "It waits for your yes." }];
    });
    await h.settle();
    expect(said[0]).toMatch(/approv/i);
    expect(g.gmail.sent).toEqual([]);
    const asks = await h.tdb.db.select().from(approval).where(eq(approval.action, "mail.send"));
    expect(asks).toMatchObject([{ status: "pending", origin: "owner" }]);
  });
});
