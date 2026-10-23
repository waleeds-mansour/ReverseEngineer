// How long one of Pip's turns may run before it's stopped. The Jarvis runner holds each turn to
// it (packages/jarvis turn-budget.ts), and Today's desk says when the running one will be.

/**
 * By lane, for a voice command (the owner is waiting on it), for a turn that uses the browser
 * (D54, B1), and for a Slack member's (D62).
 */
export const TURN_LIMIT_MS = {
  fast: 10 * 60_000,
  deep: 30 * 60_000,
  voice: 2 * 60_000,
  browser: 30 * 60_000,
  /** A Slack member's turn: two minutes, and MEMBER_STEPS model steps (D62). */
  member: 2 * 60_000,
};

/**
 * How long a turn may run, counted from its start: a voice command's or a Slack member's own
 * limit, or its lane's; once it has used the browser, the browser's if that's longer. The runner
 * picks the same way (runner.ts limitFor, and Deadline.browsing).
 */
export function turnLimitMs(
  turn: { trigger: string; lane: string },
  browsing = false,
  limits: typeof TURN_LIMIT_MS = TURN_LIMIT_MS,
): number {
  const own =
    turn.trigger === "voice_command"
      ? limits.voice
      : turn.trigger === "slack_member"
        ? limits.member
        : turn.lane === "deep"
          ? limits.deep
          : limits.fast;
  return browsing ? Math.max(own, limits.browser) : own;
}
