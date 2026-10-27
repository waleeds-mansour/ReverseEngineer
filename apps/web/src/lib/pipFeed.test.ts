// Today as Pip's feed: Pip's line says the day in sentences and leaves out what it doesn't know
// yet, the day is called light or full only when it is, what's new from Pip leaves out what has a
// place of its own, and only what can go to the trash (or has its own Undo) offers to be undone.
import { describe, expect, it } from "vitest";
import { dayLooks, newFromPip, pipDid, pipLine } from "./pipFeed.ts";
import type { Did, InboxRow, Notification } from "./types.ts";

const NOW = new Date(2026, 9, 23, 9, 40);
const at = (h: number, m = 0) => new Date(2026, 9, 23, h, m).toISOString();
const meeting = (from: number, to: number) => ({ startsAt: at(from), endsAt: at(to) });

const said = (n: Partial<Parameters<typeof pipLine>[0]>) =>
  pipLine({ approvals: 0, ready: 0, meetings: [], owed: 0, due: 0, now: NOW, ...n })
    .map((s) => s.text)
    .join(" ");

describe("Pip's line", () => {
  it("says the day in sentences, each taking you to its section", () => {
    const line = pipLine({
      approvals: 3,
      ready: 2,
      meetings: [meeting(14, 15)],
      owed: 1,
      due: 4,
      now: NOW,
    });
    expect(line).toEqual([
      { text: "One meeting, at 2 p.m.", to: "today-day" },
      { text: "3 things need your yes.", to: "today-needs" },
      { text: "I wrote 2 drafts, ready to send.", to: "today-drafts" },
      { text: "One email is waiting on your reply.", to: "today-replies" },
      { text: "4 tasks are due.", to: "today-due" },
    ]);
    expect(said({ approvals: 1, ready: 1, owed: 2, due: 1 })).toBe(
      "No meetings today. One thing needs your yes. I wrote a draft, ready to send. 2 emails are waiting on your reply. One task is due.",
    );
  });

  it("says nothing needs you only once both counts are in", () => {
    expect(said({})).toBe("No meetings today. Nothing needs you.");
    expect(said({ approvals: null })).toBe("No meetings today.");
    expect(said({ ready: null })).toBe("No meetings today.");
  });

  it("says where the meetings stand by the clock", () => {
    expect(said({ meetings: [meeting(10, 11), meeting(14, 15)] })).toContain(
      "2 meetings, the next at 10 a.m.",
    );
    expect(said({ meetings: [meeting(8, 9), meeting(14, 15)] })).toContain(
      "One meeting left, at 2 p.m.",
    );
    expect(said({ meetings: [meeting(9, 10), meeting(14, 15), meeting(16, 17)] })).toContain(
      "You're in a meeting now, and 2 more after it.",
    );
    expect(said({ meetings: [meeting(9, 10)] })).toContain(
      "You're in your last meeting of the day.",
    );
    expect(said({ meetings: [meeting(7, 8)] })).toContain("Your one meeting is over.");
    expect(said({ meetings: [meeting(7, 8), meeting(8, 9)] })).toContain(
      "Your meetings are over for today.",
    );
  });
});

describe("how the day looks", () => {
  it("is light or full only when it is", () => {
    expect(dayLooks({ meetings: 1, due: 2, waiting: 1 }, NOW)).toBe("It's a light Friday.");
    expect(dayLooks({ meetings: 5, due: 0, waiting: 0 }, NOW)).toBe("It's a full Friday.");
    expect(dayLooks({ meetings: 3, due: 3, waiting: 2 }, NOW)).toBe("It's a full Friday.");
    expect(dayLooks({ meetings: 2, due: 1, waiting: 1 }, NOW)).toBe("Here's your Friday.");
  });
});

const note = (id: string, extra: Partial<Notification> = {}): InboxRow => ({
  notification: {
    id,
    kind: "tell",
    title: `Note ${id}`,
    body: null,
    entityId: null,
    approvalId: null,
    state: "unseen",
    lane: "signal",
    urgency: "normal",
    deadline: null,
    snoozedUntil: null,
    createdBy: "jarvis",
    createdAt: at(8),
    ...extra,
  },
  entityTitle: null,
  entityType: null,
  approvalStatus: null,
});

const UNDO = {
  kind: "unmove",
  eventId: "e1",
  before: { start: at(10), end: at(11), when: "Fri 10 a.m." },
} as const;

describe("what's new from Pip", () => {
  it("leaves out what has a place of its own, and what you've seen", () => {
    const inbox = [
      note("a"),
      note("brief", { kind: "brief" }),
      note("asks", { approvalId: "ap1" }),
      note("did", { undo: UNDO }),
      note("seen", { state: "seen" }),
      note("noise", { lane: "noise" }),
      note("b"),
      note("c"),
      note("d"),
    ];
    const { rows, more } = newFromPip(inbox);
    expect(rows.map((r) => r.notification.id)).toEqual(["a", "b", "c"]);
    expect(more).toBe(1);
    expect(newFromPip(undefined)).toEqual({ rows: [], more: 0 });
  });
});

describe("what Pip did", () => {
  const did = (entityId: string, entityType: string, hour: number): Did => ({
    at: at(hour),
    text: `Made ${entityId}`,
    entityId,
    entityType,
  });
  const trashable = new Set(["task", "note", "brief"]);
  const since = new Date(2026, 9, 22);

  it("puts what it made and what it changed together, newest first, each with its undo", () => {
    const items = pipDid(
      [did("t1", "task", 7), did("d1", "email_draft", 9)],
      [
        note("moved", { undo: UNDO, createdAt: at(8) }),
        note("plain", { createdAt: at(8, 30) }),
        note("old", { undo: UNDO, createdAt: new Date(2026, 9, 20).toISOString() }),
      ],
      trashable,
      since,
    );
    expect(
      items.map((i) => (i.kind === "made" ? `${i.did.entityId}:${i.undo}` : i.row.notification.id)),
    ).toEqual(["d1:false", "moved", "t1:true"]);
  });
});
