// How a badge says how something is. Nook has five tones: positive, warning and danger say how
// something is, and always come with a dot and a word, so colour is never the only sign; accent
// means focused or selected; neutral is everything else. Hearth's older names still read as one of
// them, so a badge written before Nook keeps working (components/kit/Badge.tsx).

/** Nook's badge tones. */
export type Tone = "neutral" | "accent" | "positive" | "warning" | "danger";

/** The names Hearth's badges and pills had before Nook. */
export type OldTone = "ok" | "warn" | "bad" | "muted" | "jarvis";

const OLD: Record<OldTone, Tone> = {
  ok: "positive",
  warn: "warning",
  bad: "danger",
  muted: "neutral",
  // Pip wears the accent, and Nook keeps the accent for what's focused or selected, so a badge
  // that only said "Pip did this" is plain. One that waits on you is a warning, said where it's used.
  jarvis: "neutral",
};

/** A tone by Nook's name, whatever it came as: an older name, or none at all (neutral). */
export function toneOf(tone: Tone | OldTone | undefined): Tone {
  if (!tone) return "neutral";
  return Object.hasOwn(OLD, tone) ? OLD[tone as OldTone] : (tone as Tone);
}

const STATUS: ReadonlySet<Tone> = new Set(["positive", "warning", "danger"]);

/** Whether a tone says how something is: positive, warning or danger. */
export const isStatus = (tone: Tone) => STATUS.has(tone);

/**
 * Whether a badge has a dot before its word: as asked, or else when its tone is a status and it
 * has no icon of its own to stand in front.
 */
export function showsDot(tone: Tone, dot?: boolean, icon?: boolean): boolean {
  return dot ?? (isStatus(tone) && !icon);
}

/** How a part of Hearth reports itself in Settings' Health: the worker, a sync, the backup. */
export type Health = "ok" | "degraded" | "failing";

const HEALTH: Record<Health, { word: string; tone: Tone }> = {
  ok: { word: "Running", tone: "positive" },
  degraded: { word: "Degraded", tone: "warning" },
  failing: { word: "Failing", tone: "danger" },
};

/** A health report in a word: "Running", "Degraded" or "Failing". */
export const healthWord = (health: Health): string => HEALTH[health]?.word ?? health;

/** The tone a health report's badge takes. One Hearth doesn't know yet is neutral. */
export const healthTone = (health: Health): Tone => HEALTH[health]?.tone ?? "neutral";
