import { describe, expect, it } from "vitest";
import {
  approvalOf,
  fromSlack,
  runsOf,
  startedBy,
  type TimelineAction,
  type TimelineTurn,
} from "./activity.ts";

const turn = (t: Partial<TimelineTurn>): TimelineTurn => ({
  id: "t1",
  trigger: "chat",
  mode: "reactive",
  lane: "fast",
  status: "done",
  outcome: "act",
  reply: null,
  error: null,
  skipReason: null,
  asked: null,
  via: null,
  source: null,
  readOutside: false,
  conversationId: null,
  subjectId: null,
  queuedAt: "2026-10-01T14:00:00Z",
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  ...t,
});

let n = 0;
const action = (a: Partial<TimelineAction>): TimelineAction => ({
  id: `a${n++}`,
  at: "2026-10-01T14:00:00Z",
  action: "mail.thread",
  risk: "read",
  outcome: "ok",
  error: null,
  durationMs: 10,
  approvalId: null,
  what: null,
  ...a,
});

describe("what set a card off", () => {
  it("says who asked, which routine ran, or that Pip noticed something", () => {
    expect(startedBy({ turn: turn({}) })).toBe("You asked");
    expect(startedBy({ turn: turn({ via: "slack" }) })).toBe("You asked in Slack");
    expect(startedBy({ turn: turn({ trigger: "routine", source: "jarvis.heartbeat" }) })).toBe(
      "Heartbeat",
    );
    expect(startedBy({ turn: turn({ trigger: "routine", source: "my.own" }) })).toBe("Routine");
    expect(startedBy({ turn: null })).toBe("Noticed something");
  });

  it("knows what Slack started", () => {
    expect(fromSlack({ turn: turn({ trigger: "slack_member" }) })).toBe(true);
    expect(fromSlack({ turn: turn({ via: "slack" }) })).toBe(true);
    expect(fromSlack({ turn: turn({}) })).toBe(false);
    expect(fromSlack({ turn: null })).toBe(false);
  });
});

describe("a card's actions", () => {
  it("runs repeats together, with the first few things they were about", () => {
    const runs = runsOf({
      approvals: [],
      actions: [
        action({ what: "Invoice" }),
        action({ what: "Lunch" }),
        action({ what: "Invoice" }),
        action({ action: "task.create", risk: "internal", what: "Pay Acme" }),
        action({ what: "Offsite" }),
      ],
    });
    expect(runs.map((r) => [r.said, r.count, r.whats])).toEqual([
      ["Read an email", 3, ["Invoice", "Lunch"]],
      ["Made a task", 1, ["Pay Acme"]],
      ["Read an email", 1, ["Offsite"]],
    ]);
  });

  it("leaves out an ask the card lists as an approval, and says a failure", () => {
    const runs = runsOf({
      approvals: [
        {
          id: "ap1",
          action: "mail.send",
          summary: "Send to Ana",
          status: "pending",
          error: null,
          createdAt: "2026-10-01T14:00:00Z",
          decidedAt: null,
        },
      ],
      actions: [
        action({
          action: "mail.send",
          risk: "outward",
          outcome: "pending_approval",
          approvalId: "ap1",
        }),
        action({
          action: "mail.send",
          risk: "outward",
          outcome: "pending_approval",
          approvalId: "ap2",
        }),
        action({ action: "task.create", outcome: "error", error: "No title" }),
      ],
    });
    expect(runs.map((r) => [r.said, r.outcome])).toEqual([
      ["Asked before sending an email", "pending_approval"],
      ["Making a task failed", "error"],
    ]);
    expect(runs[1]?.error).toBe("No title");
  });

  it("says an approval's state in words", () => {
    expect(approvalOf("pending")).toEqual({ word: "Waiting on you", tone: "warning" });
    expect(approvalOf("executed").word).toBe("You said yes");
    expect(approvalOf("odd").word).toBe("odd");
  });
});
