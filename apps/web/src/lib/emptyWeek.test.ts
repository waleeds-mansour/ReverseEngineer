// A week with nothing on is called free only when Nook would know: not when Google signed Nook
// out of any account, no calendar is synced, or part of the week is outside the days Nook keeps.
import { describe, expect, it } from "vitest";
import { emptyWeek } from "./emptyWeek.ts";
import type { CalendarSetup } from "./integration-types.ts";

const CAL = "https://www.googleapis.com/auth/calendar";
/** Today: Nook keeps Sep 30 to Dec 5. */
const oct = new Date(2026, 9, 7);

const setup = (
  status: "ok" | "failing" | "revoked" = "ok",
  more: { scopes?: string[]; selected?: boolean; lastError?: string } = {},
): CalendarSetup =>
  ({
    configured: true,
    accounts: [
      {
        email: "me@x.example",
        status,
        lastError: more.lastError ?? null,
        connectedAt: "2026-09-01T00:00:00Z",
        scopes: more.scopes ?? [CAL],
      },
    ],
    calendars: [{ account: "me@x.example", selected: more.selected ?? true }],
  }) as CalendarSetup;

describe("a week with nothing on", () => {
  it("is free only when Nook syncs your calendar and keeps the whole week", () => {
    expect(emptyWeek(oct, oct, setup())).toBe("Nothing on your calendar this week.");
    // Dec 2 to 8: Nook has only up to Dec 5.
    const edge = emptyWeek(new Date(2026, 11, 2), oct, setup());
    expect(edge).toMatch(/^Nothing on your calendar to .*Dec.* 5\. Nook keeps/);
    expect(edge).toContain("Google Calendar");
    expect(emptyWeek(new Date(2026, 11, 9), oct, setup())).toMatch(/^Nook keeps/);
    // Last week is kept; the week before isn't.
    expect(emptyWeek(new Date(2026, 8, 30), oct, setup())).toBe(
      "Nothing on your calendar that week.",
    );
    expect(emptyWeek(new Date(2026, 8, 23), oct, setup())).toMatch(
      /^Nook keeps your calendar from 7 days back, .*Sep.* 30\. For earlier, open Google Calendar\.$/,
    );
  });

  it("says which account's calendars are missing when another's are there", () => {
    const two = (status: "failing" | "revoked") => {
      const s = setup();
      const other = { ...s.accounts[0]!, email: "work@x.example", status };
      return {
        ...s,
        accounts: [...s.accounts, other],
        calendars: [...s.calendars, { ...s.calendars[0]!, account: other.email }],
      } as CalendarSetup;
    };
    expect(emptyWeek(oct, oct, two("revoked"))).toBe(
      "Nothing here this week on your other calendars, but Google signed Nook out of work@x.example. Connect it again in Settings.",
    );
    expect(emptyWeek(oct, oct, two("failing"))).toMatch(
      /couldn't reach Google for work@x\.example/,
    );
  });

  it("says what's missing instead", () => {
    expect(emptyWeek(oct, oct, setup("revoked"))).toBe(
      "Google signed Nook out. Connect it again in Settings.",
    );
    expect(emptyWeek(oct, oct, setup("revoked", { lastError: "Sign in again." }))).toBe(
      "Sign in again.",
    );
    expect(emptyWeek(oct, oct, { ...setup(), accounts: [] })).toBe(
      "Google Calendar isn't connected yet. Connect it in Settings.",
    );
    expect(emptyWeek(oct, oct, setup("ok", { scopes: ["openid"] }))).toMatch(/isn't connected/);
    expect(emptyWeek(oct, oct, setup("ok", { selected: false }))).toBe(
      "Nook isn't syncing any of your calendars. Choose them in Settings.",
    );
    expect(emptyWeek(oct, oct, setup("failing"))).toMatch(/couldn't reach Google lately/);
  });
});
