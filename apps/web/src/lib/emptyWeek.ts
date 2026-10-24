// What Calendar says about a week with nothing on. "Nothing on your calendar" only when Nook
// would know: Google connected and syncing every account's calendars, and every day of the week
// one Nook keeps. Otherwise it says what's missing, so a sign-out, a week past day 60 or one before
// the days Nook keeps never reads as a free week.

import { date } from "./format.ts";
import type { CalendarSetup } from "./integration-types.ts";
import { SYNCED_DAYS_AHEAD, SYNCED_DAYS_BACK, syncedFrom, syncedUntil, weeksOn } from "./week.ts";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";

/** Past the last day Nook keeps: where to look instead. */
export const pastKept = (until: Date) =>
  `Nook keeps your calendar ${SYNCED_DAYS_AHEAD} days ahead, to ${date(new Date(until.getTime() - 1))}. For later, open Google Calendar.`;

/** A week from `from` outside the days Nook keeps as of `today`, in words; null when it isn't. */
export function notKept(from: Date, today: Date): string | null {
  const until = syncedUntil(today);
  if (from >= until) return pastKept(until);
  const since = syncedFrom(today);
  if (from < since)
    return `Nook keeps your calendar from ${SYNCED_DAYS_BACK} days back, ${date(since)}. For earlier, open Google Calendar.`;
  return null;
}

/** The words for a week from `from` with nothing on, as of `today`. */
export function emptyWeek(from: Date, today: Date, setup: CalendarSetup): string {
  const out = notKept(from, today);
  if (out) return out;
  const until = syncedUntil(today);
  const week = from.getTime() === today.getTime() ? "this week" : "that week";
  const withCalendar = setup.accounts.filter((a) => a.scopes.includes(CALENDAR_SCOPE));
  const syncing = withCalendar.filter((a) => a.status !== "revoked");
  if (syncing.length === 0) {
    const out = withCalendar.find((a) => a.status === "revoked");
    if (out) return out.lastError || "Google signed Nook out. Connect it again in Settings.";
    return "Google Calendar isn't connected yet. Connect it in Settings.";
  }
  const accounts = new Set(syncing.map((a) => a.email));
  if (!setup.calendars.some((c) => c.selected && accounts.has(c.account)))
    return "Nook isn't syncing any of your calendars. Choose them in Settings.";
  if (syncing.every((a) => a.status === "failing"))
    return `Nothing here ${week}, but Nook couldn't reach Google lately (Settings).`;
  // One account's calendars are missing, though another's are here.
  const signedOut = withCalendar.find((a) => a.status === "revoked");
  if (signedOut)
    return `Nothing here ${week} on your other calendars, but Google signed Nook out of ${signedOut.email}. Connect it again in Settings.`;
  const failing = syncing.find((a) => a.status === "failing");
  if (failing)
    return `Nothing here ${week} on your other calendars, but Nook couldn't reach Google for ${failing.email} lately (Settings).`;
  if (weeksOn(from, 1) > until)
    return `Nothing on your calendar to ${date(new Date(until.getTime() - 1))}. ${pastKept(until)}`;
  return `Nothing on your calendar ${week}.`;
}
