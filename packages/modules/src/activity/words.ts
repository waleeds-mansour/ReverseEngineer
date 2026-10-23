// What an action was about, in a few words, from the input its audit row kept: a task's title, a
// search's words, an email's subject. Inputs that only name a record (record.read's id) say so by
// its id, for the timeline to put the record's title there instead.
import { isUuid } from "@hearth/core";

/** Fields that say what a call was about, best first. */
const SAYS = ["title", "subject", "summary", "name", "query", "description", "text", "url"];

/** Fields that name the record a call acted on. */
const NAMES = [
  "id",
  "entityId",
  "threadId",
  "taskId",
  "noteId",
  "eventId",
  "recordId",
  "subjectId",
];

const MAX = 80;

/** One line, at most MAX characters: newlines and runs of spaces become one space. */
export function clip(text: string | null | undefined, max = MAX): string | null {
  if (typeof text !== "string") return null;
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const fields = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

/** A few words for what the call was about, or null when its input says nothing plain. */
export function inputWords(input: unknown): string | null {
  const i = fields(input);
  for (const key of SAYS) {
    const said = clip(typeof i[key] === "string" ? (i[key] as string) : null);
    if (said) return said;
  }
  return null;
}

/** The record the call acted on, when its input names one by id. */
export function recordIn(input: unknown): string | null {
  const i = fields(input);
  for (const key of NAMES) {
    const v = i[key];
    if (typeof v === "string" && isUuid(v)) return v;
  }
  return null;
}
