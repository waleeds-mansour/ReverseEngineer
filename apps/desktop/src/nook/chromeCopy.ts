// Everything the Nook bar and its popover say. Plain and calm, in Hearth's voice; Pip speaks in
// short sentences and never with exclamation marks.

import type { Health, PipMood, ServicesView } from "@/bindings";

export type Tone = "ok" | "warn" | "bad" | "quiet";

/** The services badge in the bar: one tone and a few words. */
export function servicesLine(s: ServicesView): { tone: Tone; text: string } {
  if (!s.checked) return { tone: "quiet", text: "Checking Nook" };
  if (!s.address_set) return { tone: "warn", text: "Not connected" };
  if (s.server === "down") return { tone: "bad", text: "Nook isn't answering" };
  if (s.server === "unknown") return { tone: "quiet", text: "Checking Nook" };
  const troubled = (h: Health) => h === "trouble" || h === "down";
  if (
    troubled(s.server) ||
    troubled(s.worker) ||
    troubled(s.pip) ||
    s.other_failing
  ) {
    return { tone: "warn", text: "Nook needs a look" };
  }
  if (s.pip_paused) return { tone: "quiet", text: "Pip is paused" };
  return { tone: "ok", text: "Services OK" };
}

export const health: Record<Health, string> = {
  ok: "Running",
  trouble: "Having trouble",
  down: "Not answering",
  unknown: "Not checked yet",
};

/** What Pip says it is doing, in the island and the popover. */
export const doing: Record<PipMood, string> = {
  idle: "Resting",
  listening: "Listening",
  thinking: "Thinking",
  happy: "Done",
};

export const chromeCopy = {
  pip: "Pip",
  waiting: (n: number) =>
    n === 1 ? "1 thing waits for you" : `${n} things wait for you`,
  pipLabel: (mood: PipMood, waiting: number) =>
    waiting > 0
      ? `Pip: ${waiting === 1 ? "1 thing waits" : `${waiting} things wait`} for you`
      : `Pip: ${doing[mood].toLowerCase()}`,
  stop: "to stop",
  server: "Nook's server",
  worker: "Background work",
  paused: "Paused",
  otherFailing: "Something Nook watches is failing",
  openToday: "Open Today",
  servicesTitle: "Services",
} as const;

/** The clock in the bar: "Tue 13 Oct 9:41" in the owner's own format. */
export function clockText(now: Date, locale?: string): string {
  const day = now.toLocaleDateString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const time = now.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day.replace(/,/g, "")} ${time}`;
}

/** Milliseconds until the next minute begins, for the one timer the clock keeps. */
export function untilNextMinute(now: Date): number {
  return 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
}
