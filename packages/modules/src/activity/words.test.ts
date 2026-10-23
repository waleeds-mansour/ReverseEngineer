import { describe, expect, it } from "vitest";
import { clip, inputWords, recordIn } from "./words.ts";

const ID = "01923a4b-5c6d-7e8f-9a0b-1c2d3e4f5a6b";

describe("what an action was about", () => {
  it("says a title, a subject or a search first", () => {
    expect(inputWords({ title: "Call Sam", text: "long body" })).toBe("Call Sam");
    expect(inputWords({ query: "invoice from Acme" })).toBe("invoice from Acme");
    expect(inputWords({ subject: "  Friday's\n agenda " })).toBe("Friday's agenda");
  });

  it("says nothing for an input with no plain words, or one kept secret", () => {
    expect(inputWords({ id: ID })).toBeNull();
    expect(inputWords({ redacted: true })).toBeNull();
    expect(inputWords(null)).toBeNull();
    expect(inputWords(["a"])).toBeNull();
  });

  it("finds the record a call names by id", () => {
    expect(recordIn({ threadId: ID })).toBe(ID);
    expect(recordIn({ id: "not-an-id" })).toBeNull();
  });

  it("keeps a line short", () => {
    expect(clip("a".repeat(100))).toHaveLength(80);
    expect(clip("a".repeat(100))?.endsWith("…")).toBe(true);
    expect(clip("   ")).toBeNull();
  });
});
