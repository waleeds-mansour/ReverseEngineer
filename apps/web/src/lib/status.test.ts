// A badge's tone is one of Nook's five whatever name it came by, a status has its dot unless an
// icon stands in front, and a health report reads as a word.
import { describe, expect, it } from "vitest";
import {
  healthTone,
  healthWord,
  isStatus,
  type OldTone,
  showsDot,
  type Tone,
  toneOf,
} from "./status.ts";

const NOOK: Tone[] = ["neutral", "accent", "positive", "warning", "danger"];

describe("a badge's tone", () => {
  it("keeps Nook's own names", () => {
    for (const tone of NOOK) expect(toneOf(tone)).toBe(tone);
  });

  it("reads Hearth's older names as Nook's", () => {
    const old: Record<OldTone, Tone> = {
      ok: "positive",
      warn: "warning",
      bad: "danger",
      muted: "neutral",
      jarvis: "neutral",
    };
    for (const [from, to] of Object.entries(old)) expect(toneOf(from as OldTone), from).toBe(to);
  });

  it("is neutral when none is given", () => {
    expect(toneOf(undefined)).toBe("neutral");
  });

  it("is a status only for positive, warning and danger", () => {
    expect(NOOK.filter(isStatus)).toEqual(["positive", "warning", "danger"]);
  });
});

describe("a badge's dot", () => {
  it("shows on a status, and not on neutral or accent", () => {
    expect(NOOK.filter((t) => showsDot(t))).toEqual(["positive", "warning", "danger"]);
  });

  it("gives way to an icon of the badge's own", () => {
    expect(showsDot("warning", undefined, true)).toBe(false);
  });

  it("does as it's asked either way", () => {
    expect(showsDot("positive", false)).toBe(false);
    expect(showsDot("neutral", true)).toBe(true);
    expect(showsDot("accent", true, true)).toBe(true);
  });
});

describe("a health report", () => {
  it("reads as a word", () => {
    expect(healthWord("ok")).toBe("Running");
    expect(healthWord("degraded")).toBe("Degraded");
    expect(healthWord("failing")).toBe("Failing");
  });

  it("takes the tone that goes with it", () => {
    expect(healthTone("ok")).toBe("positive");
    expect(healthTone("degraded")).toBe("warning");
    expect(healthTone("failing")).toBe("danger");
  });

  it("says one Hearth doesn't know as it came, in a neutral badge", () => {
    const unknown = "starting" as Parameters<typeof healthWord>[0];
    expect(healthWord(unknown)).toBe("starting");
    expect(healthTone(unknown)).toBe("neutral");
  });
});
