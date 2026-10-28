import { describe, expect, it } from "vitest";
import { foldConversation, type LogRecord, readyReplies } from "./conversation.ts";

let idx = 0;
const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 14, 0, s)).toISOString();
const entry = (kind: string, payload: Record<string, unknown>, turnId: string | null = null) =>
  ({ idx: idx++, at: at(idx), turnId, kind, payload }) satisfies LogRecord;

describe("foldConversation", () => {
  it("knows when you're waiting for Jarvis to start", () => {
    idx = 0;
    const asked = [entry("user_message", { text: "hi" })];
    expect(foldConversation(asked).waitingSince).toBe(at(1));
    const started = [...asked, entry("turn_started", {}, "t1")];
    expect(foldConversation(started)).toMatchObject({ waitingSince: null, activeTurns: ["t1"] });

    // Said while that turn runs: still waiting after it ends, until the next one starts.
    const more = [...started, entry("user_message", { text: "also" })];
    const ended = [
      ...more,
      entry("assistant_message", { text: "Hi." }, "t1"),
      entry("turn_finished", { status: "done" }, "t1"),
    ];
    expect(foldConversation(ended).waitingSince).toBe(at(3));
    // Stopped before it started: no longer waiting.
    const stopped = [...ended, entry("notice", { text: "Stopped before Jarvis started." }, "t2")];
    expect(foldConversation(stopped).waitingSince).toBeNull();
  });

  it("doesn't wait on a routine's own prompt", () => {
    idx = 0;
    const log = [
      entry("turn_started", {}, "r1"),
      entry("user_message", { text: "It's time for the brief.", by: "system" }, "r1"),
      entry("turn_finished", { status: "done" }, "r1"),
    ];
    expect(foldConversation(log).waitingSince).toBeNull();
  });

  it("offers Retry on the latest failure only, until something else happens", () => {
    idx = 0;
    const log = [
      entry("user_message", { text: "one" }),
      entry("turn_started", {}, "t1"),
      entry("error", { message: "Claude turned down the request.", retry: true }, "t1"),
      entry("turn_finished", { status: "failed" }, "t1"),
    ];
    const notice = (l: LogRecord[]) => foldConversation(l).items.filter((i) => i.type === "notice");
    expect(notice(log)).toMatchObject([{ tone: "error", retry: true, turnId: "t1" }]);
    expect(foldConversation(log).activeTurns).toEqual([]);

    // Pressing Retry takes the link away at once, and the new turn waits like a message.
    const pressed = [...log, entry("notice", { text: "Trying again.", retrying: true }, "t2")];
    expect(notice(pressed)).toMatchObject([{ retry: false }, { text: "Trying again." }]);
    expect(foldConversation(pressed).waitingSince).toBe(at(5));

    const retried = [...pressed, entry("turn_started", {}, "t2")];
    expect(notice(retried)).toMatchObject([{ retry: false }, {}]);
    expect(foldConversation(retried).waitingSince).toBeNull();

    const waiting = [
      entry(
        "error",
        { message: "Claude is overloaded. Jarvis will try again.", retry: false },
        "t3",
      ),
    ];
    expect(notice(waiting)).toMatchObject([{ retry: false }]);
  });
});

describe("ready replies (D85)", () => {
  it("shows the latest ones after Pip's answer, and none once you write or a turn starts", () => {
    idx = 0;
    const answered = [
      entry("user_message", { text: "draft a reply to Ana", by: "owner" }),
      entry("turn_started", {}, "t1"),
      entry("assistant_message", { text: "Here's a draft…" }, "t1"),
      entry("turn_finished", { status: "done" }, "t1"),
      entry("next", { replies: ["Send it", "Make it shorter"] }, "t1"),
    ];
    // Not a line of its own: the replies sit beside the conversation.
    expect(foldConversation(answered).items).toHaveLength(2);
    expect(foldConversation(answered).next).toEqual({
      replies: ["Send it", "Make it shorter"],
      outside: false,
    });
    // Only the latest, and never more than two.
    const again = [...answered, entry("next", { replies: ["Yes", "No", "Maybe"] }, "t1")];
    expect(readyReplies(again).replies).toEqual(["Yes", "No"]);
    // Anything you write makes them stale; so does a turn that started since.
    const none = { replies: [], outside: false };
    expect(readyReplies([...answered, entry("user_message", { text: "Send it" })])).toEqual(none);
    expect(readyReplies([...answered, entry("turn_started", {}, "t2")])).toEqual(none);
    // Written after reading outside content: the overlay marks them (D58).
    const read = [...answered, entry("next", { replies: ["Reply"], outside: true }, "t1")];
    expect(readyReplies(read)).toEqual({ replies: ["Reply"], outside: true });
  });

  it("isn't made stale by a routine's prompt or a Slack member's line, and skips what isn't text", () => {
    idx = 0;
    const log = [
      entry("next", { replies: ["Send it", 3, ""] }, "t1"),
      entry("user_message", { text: "It's time.", by: "system" }, "r1"),
      entry("user_message", { text: "hi", by: "member:slack:T1:U1" }),
    ];
    expect(readyReplies(log).replies).toEqual(["Send it"]);
    expect(readyReplies([entry("next", { replies: "Send it" }, "t1")]).replies).toEqual([]);
  });
});
