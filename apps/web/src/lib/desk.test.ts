import { describe, expect, it } from "vitest";
import { type DeskTurn, deskTitle, runningLine, waitingLine } from "./desk.ts";

/** Local times on Oct 1, as the desk says them. */
const at = (h: number, m = 0) => new Date(2026, 9, 1, h, m);

const turn = (t: Partial<DeskTurn>): DeskTurn => ({
  id: "t1",
  trigger: "chat",
  mode: "reactive",
  lane: "fast",
  status: "running",
  outcome: null,
  reply: null,
  error: null,
  skipReason: null,
  asked: null,
  via: null,
  source: null,
  readOutside: false,
  conversationId: null,
  subjectId: null,
  queuedAt: at(14).toISOString(),
  startedAt: at(14).toISOString(),
  finishedAt: null,
  durationMs: null,
  notBefore: at(14).toISOString(),
  deadline: at(14, 30).toISOString(),
  stopping: false,
  browsing: false,
  ...t,
});

describe("Pip's desk", () => {
  it("says what a turn is about: your words, or what set it off", () => {
    expect(deskTitle(turn({ asked: "Write up the agenda" }))).toBe("“Write up the agenda”");
    expect(deskTitle(turn({ trigger: "routine", source: "brief" }))).toBe("Morning brief");
    expect(deskTitle(turn({ trigger: "reflex" }))).toBe("Noticed something");
  });

  it("says how long the running turn has been going, and until when it has", () => {
    expect(runningLine(turn({}), at(14))).toBe("Just started · has until 2:30 p.m.");
    expect(runningLine(turn({}), at(14, 4))).toBe("4 min so far · has until 2:30 p.m.");
    const long = turn({ deadline: at(16).toISOString() });
    expect(runningLine(long, at(15, 5))).toBe("1 h 5 min so far · has until 4 p.m.");
    expect(runningLine(long, at(15))).toBe("1 h so far · has until 4 p.m.");
  });

  it("says when it's stopping, and when it's past its time", () => {
    expect(runningLine(turn({ stopping: true }), at(14, 4))).toBe("Stopping…");
    expect(runningLine(turn({}), at(14, 35))).toBe("35 min so far · past its time");
  });

  it("says since when something has waited, or when it can go", () => {
    const waiting = turn({ status: "queued", startedAt: null, deadline: null });
    expect(waitingLine(waiting, at(14, 5))).toBe("In line since 2 p.m.");
    const later = { ...waiting, notBefore: at(14, 40).toISOString() };
    expect(waitingLine(later, at(14, 5))).toBe("Waits until 2:40 p.m.");
  });
});
