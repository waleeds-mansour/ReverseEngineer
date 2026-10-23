import { describe, expect, it } from "vitest";
import { TURN_LIMIT_MS, turnLimitMs } from "./turns.ts";

describe("how long a turn may run", () => {
  it("goes by its lane, or a voice command's or a Slack member's own", () => {
    expect(turnLimitMs({ trigger: "chat", lane: "fast" })).toBe(TURN_LIMIT_MS.fast);
    expect(turnLimitMs({ trigger: "routine", lane: "deep" })).toBe(TURN_LIMIT_MS.deep);
    expect(turnLimitMs({ trigger: "voice_command", lane: "fast" })).toBe(TURN_LIMIT_MS.voice);
    expect(turnLimitMs({ trigger: "slack_member", lane: "deep" })).toBe(TURN_LIMIT_MS.member);
  });

  it("gets the browser's time once it has used the browser, never less than its own", () => {
    expect(turnLimitMs({ trigger: "voice_command", lane: "fast" }, true)).toBe(
      TURN_LIMIT_MS.browser,
    );
    const limits = { ...TURN_LIMIT_MS, deep: 60 * 60_000 };
    expect(turnLimitMs({ trigger: "chat", lane: "deep" }, true, limits)).toBe(60 * 60_000);
  });
});
