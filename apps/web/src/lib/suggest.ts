// Pip's suggested times on Calendar. Find a time asks the server for free times in the days shown:
// calendar.find_time when you name guests (your working hours less theirs, as Google's free/busy
// shows them), calendar.free_time when it's just you. Each free time becomes one suggestion at its
// start, as long as you asked, a few a day, never one that's begun; and Calendar says plainly what
// it couldn't count: a guest whose calendar it couldn't see, and the days past those Nook knows. It
// only says a time suits the guests whose calendars it could see, and names every guest it invites.

import { daysOn } from "./calLayout.ts";
import { date, hours } from "./format.ts";
import { syncedUntil } from "./week.ts";

/** A free time as the server gives it: at least as long as was asked. */
export interface FreeSlot {
  start: string;
  end: string;
}

/** What calendar.find_time answers. */
export interface FoundTimes {
  slots: FreeSlot[];
  /** The guests whose busy times were counted. */
  checked: string[];
  /** The guests whose weren't, and why. */
  unseen: { address: string; why: string }[];
  /** Where the times stopped short: Nook doesn't know your calendar past it. */
  knownUntil?: string;
}

/** A time Pip suggests: a free time's start, as long as you asked. */
export interface Suggestion {
  start: Date;
  end: Date;
}

/** The lengths you can ask for, in minutes. */
export const LENGTHS = [15, 30, 45, 60, 90] as const;
export const DEFAULT_LENGTH = 30;
/** At most this many a day, and this many in all, so the grid still reads as your week. */
export const PER_DAY = 3;
export const MOST = 10;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** The most days the server looks over at once (calendar.find_time, calendar.free_time). */
const MOST_DAYS = 30;

/** The days shown: from the first's start to the start of the day after the last. */
export interface Range {
  from: Date;
  to: Date;
}

/**
 * What to ask the server for the days in `range`: find_time with guests, free_time without. None
 * when those days have passed, since nothing in them can be suggested.
 */
export function findInput(range: Range, minutes: number, guests: readonly string[], now: Date) {
  if (range.to <= now) return null;
  const span = Math.ceil((range.to.getTime() - range.from.getTime()) / DAY_MS);
  const base = {
    minutes,
    from: range.from.toISOString(),
    days: Math.min(MOST_DAYS, Math.max(1, span)),
  };
  return guests.length
    ? { action: "calendar.find_time" as const, input: { ...base, guests: [...guests] } }
    : { action: "calendar.free_time" as const, input: base };
}

/**
 * The times to suggest: each free time's start, `minutes` long, inside `range`, after `now` and
 * never across midnight, at most `perDay` a day and `most` in all, earliest first.
 */
export function suggest(
  slots: readonly FreeSlot[],
  minutes: number,
  range: Range,
  { now, perDay = PER_DAY, most = MOST }: { now?: Date; perDay?: number; most?: number } = {},
): Suggestion[] {
  const out: Suggestion[] = [];
  const taken = new Map<number, number>();
  const sorted = [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (const slot of sorted) {
    const start = new Date(slot.start);
    const end = new Date(start.getTime() + minutes * MINUTE_MS);
    if (Number.isNaN(start.getTime()) || end.getTime() > Date.parse(slot.end)) continue;
    if (start < range.from || end > range.to || (now && start <= now)) continue;
    const day = daysOn(start, 0).getTime();
    if (end > daysOn(start, 1)) continue;
    const n = taken.get(day) ?? 0;
    if (n >= perDay) continue;
    taken.set(day, n + 1);
    out.push({ start, end });
    if (out.length >= most) break;
  }
  return out;
}

/**
 * Where the days shown run past those Nook keeps of your calendar (calendar/sync.ts), as
 * calendar.find_time says it: free_time doesn't, so with no guests Calendar works it out.
 */
export const knownFor = (range: Range, today: Date) =>
  range.to > syncedUntil(today) ? syncedUntil(today).toISOString() : undefined;

/** The suggestions on `day` (a day's start). */
export const suggestedOn = (list: readonly Suggestion[], day: Date) =>
  list.filter((s) => daysOn(s.start, 0).getTime() === day.getTime());

/** An address as the server's zod .email() takes it, so Calendar never asks with one it refuses. */
const EMAIL =
  /^(?:[A-Za-z0-9_'+-]+\.)*[A-Za-z0-9_'+-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

const GMAIL = new Set(["gmail.com", "googlemail.com"]);

/** A key for each mailbox, as mail/mine.ts keys them: no case, no +tag, and Gmail's dots ignored. */
export function addressKey(address: string): string {
  const a = address.trim().toLowerCase();
  const at = a.lastIndexOf("@");
  if (at <= 0) return a;
  const domain = a.slice(at + 1);
  const name = a.slice(0, at).split("+")[0] || a.slice(0, at);
  return GMAIL.has(domain) ? `${name.replaceAll(".", "")}@gmail.com` : `${name}@${domain}`;
}

/**
 * The guests typed into Who: email addresses, split at commas, semicolons or spaces, each once.
 * `bad` is what isn't an address, so Calendar can say so rather than ask with it. Your own
 * addresses (`own`) aren't guests: that's you, so with only them it's time of your own.
 */
export function readGuests(text: string, own: readonly string[] = []) {
  const guests: string[] = [];
  const bad: string[] = [];
  const seen = new Set(own.map(addressKey));
  // “Lee Park <lee@work.example>” as a mail app copies it: just the address.
  const plain = text.replace(/[^,;<>]*<([^<>\s]+)>/g, " $1 ");
  for (const address of plain.split(/[\s,;]+/).filter(Boolean)) {
    if (!EMAIL.test(address)) bad.push(address);
    else if (!seen.has(addressKey(address))) {
      seen.add(addressKey(address));
      guests.push(address);
    }
  }
  return { guests, bad };
}

/** "Lee" for lee@work.example, "Sam Lee" for sam.lee@…; the address when it isn't plain words. */
export function guestName(address: string): string {
  const local = address.split("@")[0] ?? "";
  const words = local.split(/[._-]+/).filter(Boolean);
  if (!words.length || !words.every((w) => /^[a-z]+$/i.test(w))) return address;
  return words.map((w) => `${w[0]!.toUpperCase()}${w.slice(1).toLowerCase()}`).join(" ");
}

/** Names in a sentence: "Sam", "Sam and Lee", "Sam, Lee and Pat". */
const inWords = (names: readonly string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Most guests named one by one. */
const NAMED = 4;

/**
 * Every guest by name, up to four: "Sam", "Sam, Lee, Pat and Jo"; past that the first three and
 * how many more, "Sam, Lee, Pat and 3 others", with everyone() for the whole list.
 */
export function guestList(guests: readonly string[]): string {
  const names = guests.map(guestName);
  if (names.length <= NAMED) return inWords(names);
  return inWords([...names.slice(0, NAMED - 1), `${names.length - NAMED + 1} others`]);
}

/** Every guest by name, however many: what a list cut short to "3 others" stands for. */
export const everyone = (guests: readonly string[]) => inWords(guests.map(guestName));

/** What it's called when you didn't say: "Meeting with Sam", or "Busy" for time of your own. */
export const titleFor = (title: string, guests: readonly string[]) =>
  title.trim() || (guests.length ? `Meeting with ${guestList(guests)}` : "Busy");

/** "15 min", "1 hour", "90 min". */
export const lengthLabel = (minutes: number) => (minutes === 60 ? "1 hour" : `${minutes} min`);

/**
 * What picking a time with guests asks before they're invited, naming them, the meeting and when:
 * “Invite Sam and 2 others to “Sync” Thu, Oct 29, 10:30 to 11 a.m.?”
 */
export function inviteQuestion(
  title: string,
  guests: readonly string[],
  s: Suggestion,
  now?: Date,
): string {
  const name = title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title;
  const on = now ? date(s.start, now) : date(s.start);
  return `Invite ${guestList(guests)} to “${name}” ${on}, ${hours(s.start, s.end)}?`;
}

/** What a screen reader hears for a suggestion: when, and what picking it does. */
export function suggestionLabel(s: Suggestion, guests: readonly string[], now?: Date): string {
  const on = now ? date(s.start, now) : date(s.start);
  const does = guests.length ? `invite ${guestList(guests)}` : "add it to your calendar";
  return `Pip suggests ${on}, ${hours(s.start, s.end)}: ${does}`;
}

/** Why a guest's calendar wasn't counted, said to you. */
function unseenWhy(why: string): string {
  if (/isn't shared/i.test(why)) return "it isn't shared with your Google accounts";
  if (/couldn't be asked/i.test(why)) return "Google couldn't be asked";
  const said = why.replace(/\.$/, "").trim();
  return said ? `${said[0]!.toLowerCase()}${said.slice(1)}` : "Google didn't say why";
}

/**
 * A line for each guest whose calendar wasn't counted: “Couldn't see Lee's calendar: it isn't
 * shared with your Google accounts.” Those not asked at all (the days have passed, or are past
 * what Nook knows) are left to the line about the days.
 */
export const unseenLines = (unseen: FoundTimes["unseen"]) =>
  unseen
    .filter((u) => !/^Not asked/.test(u.why))
    .map((u) => `Couldn't see ${guestName(u.address)}'s calendar: ${unseenWhy(u.why)}.`);

/** “Nook knows your calendar only through Thu, Dec 24.”, from where the times stopped short. */
export function knownLine(knownUntil: string, now?: Date): string {
  const last = daysOn(new Date(Date.parse(knownUntil) - 1), 0);
  return `Nook knows your calendar only through ${now ? date(last, now) : date(last)}.`;
}

/**
 * Who the times suit, claiming only the guests whose calendars were seen (`checked`): "you're all
 * free", "you and Sam are free", or just "you're free" (`blind` when there were guests).
 */
function freeFor(guests: readonly string[], checked: readonly string[]) {
  const seen = guests.filter((g) => checked.some((c) => addressKey(c) === addressKey(g)));
  if (guests.length && seen.length === guests.length) return { free: "you're all free" };
  if (seen.length) return { free: `you and ${guestList(seen)} are free` };
  return { free: "you're free", blind: guests.length > 0 };
}

/**
 * What Calendar says of what it found in the days shown (`where`: "that week", "that day", "in
 * October"): how many it suggests, for whom, and what picking one does, or that nothing fits.
 */
export function foundLine(
  count: number,
  minutes: number,
  guests: readonly string[],
  checked: readonly string[],
  where: string,
) {
  const long = lengthLabel(minutes);
  const { free, blind } = freeFor(guests, checked);
  const others = blind ? " Pip couldn't see anyone else's calendar." : "";
  if (!count)
    return guests.length && !blind
      ? `No time ${where} when ${free} for ${long}.`
      : `Nothing free ${where} for ${long}.${others}`;
  const times = count === 1 ? "1 time" : `${count} times`;
  return guests.length
    ? `Pip suggests ${times} ${where} when ${free}.${others} Pick one to invite ${guestList(guests)}.`
    : `Pip suggests ${times} ${where}. Pick one to add it.`;
}
