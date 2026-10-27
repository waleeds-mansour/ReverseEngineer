// The words of an Undo that stands for many: one line for a whole triage, and a sender's Undo that
// moves back only the first MOVED_BACK of their conversations says so.
import { newId } from "@hearth/kernel";
import { describe, expect, it } from "vitest";
import { MOVED_BACK } from "../mail/lanes.ts";
import type { Change } from "./undo-facts.ts";
import type { MailFacts } from "./undo-mail-facts.ts";
import { lanePiece } from "./undo-mail-lane.ts";
import { laneWords, manyWords } from "./undo-words.ts";

describe("a sender's Undo", () => {
  it("says it moves back only the first 500 of more", () => {
    expect(laneWords("shop.example", "noise", null, 500, 812).label).toBe(
      'Undo: forget the Noise rule for "shop.example" and move the first 500 of its 812 conversations back to Signal',
    );
    expect(laneWords("shop.example", "noise", "signal", 500, 812).label).toBe(
      'Undo: send mail from "shop.example" back to Signal and move the first 500 of its 812 conversations back',
    );
    expect(laneWords("shop.example", "noise", "noise", 500, 812).label).toBe(
      'Undo: move the first 500 of the 812 conversations from "shop.example" back to Signal',
    );
    expect(laneWords("shop.example", "noise", null, 2).label).toBe(
      'Undo: forget the Noise rule for "shop.example" and move its 2 conversations back to Signal',
    );
  });

  it("is said from what the change recorded: how many it moved, and which it kept", () => {
    const threads = Array.from({ length: MOVED_BACK }, () => newId());
    const e: Change = {
      id: newId(),
      seq: 1,
      at: new Date(),
      kind: "mail.changed",
      entityId: null,
      correlationId: newId(),
      payload: { lane: "noise", moved: 812, pattern: "shop.example", was: null, threads },
    };
    const f: MailFacts = {
      labels: new Map(),
      threads: new Map(),
      rules: new Map([["shop.example", "noise"]]),
      later: [],
    };
    const v = lanePiece(e, f);
    expect(v?.label).toContain("the first 500 of its 812 conversations");
    expect(v?.inverse).toMatchObject({ action: "mail.lane_back", input: { threads } });
    expect(v?.reality).toBeNull();
  });
});

describe("one line for many conversations", () => {
  it("says how many, and how many changed since it leaves as they are", () => {
    expect(manyWords("archive", 20, 20)).toEqual({
      did: "Archived 20 conversations",
      label: "Undo: put the 20 conversations back in the inbox",
    });
    expect(manyWords("archive", 20, 18).label).toBe(
      "Undo: put 18 of the 20 conversations back in the inbox; 2 changed since stay as they are",
    );
    expect(manyWords("trash", 3, 2).label).toBe(
      "Undo: bring 2 of the 3 conversations back from the trash; 1 changed since stays as it is",
    );
    expect(manyWords("bundle:Updates", 3, 3)).toEqual({
      did: "Moved 3 conversations to Updates",
      label: "Undo: move the 3 conversations back where they were",
    });
    expect(manyWords("bundle:", 2, 2).did).toBe("Let the rules sort 2 conversations again");
    expect(manyWords("no_reply", 4, 4).did).toBe("Said 4 conversations need no reply");
  });
});
