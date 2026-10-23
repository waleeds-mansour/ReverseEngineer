// The events a trigger can wait for (Spec 6): a short list of things that happen to you (mail,
// tasks, calendar, Notion, GitHub), never Nook's own plumbing. Each says which payload fields a
// filter may test, which the turn is shown, and whether its words come from outside Nook.
import { TASK_STATUSES } from "@hearth/core";

export interface TriggerField {
  key: string;
  label: string;
  /** The values it can take, when they're few: Settings offers them as a choice. */
  values?: { value: string; label: string }[];
  /** A hint for typing one, when they aren't. */
  hint?: string;
}

export interface TriggerKind {
  label: string;
  fields: TriggerField[];
  /** The payload fields the turn is shown, in this order. */
  shows: string[];
  /** Its words come from outside Nook (an email's subject), so the turn starts untrusted (D25). */
  outside: boolean;
  /** An event of this kind that isn't news (Notion's first read of the board) fires nothing. */
  quiet?: (payload: Record<string, unknown>) => boolean;
}

const MINE = {
  key: "mine",
  label: "Whose",
  values: [
    { value: "true", label: "Yours" },
    { value: "false", label: "Someone else's" },
  ],
};
const REPO = { key: "repo", label: "Repository", hint: "owner/name" };
const AUTHOR = { key: "author", label: "Author", hint: "their GitHub login" };
const backfill = (p: Record<string, unknown>) => p.backfill === true;

export const TRIGGER_KINDS: Record<string, TriggerKind> = {
  "mail.received": {
    label: "An email arrives",
    fields: [{ key: "from", label: "From", hint: "an address, like ana@acme.com" }],
    shows: ["from", "subject"],
    outside: true,
  },
  "task.assigned": {
    label: "A task is assigned",
    fields: [
      {
        key: "to",
        label: "To",
        values: [
          { value: "owner", label: "You" },
          { value: "jarvis", label: "Pip" },
        ],
      },
    ],
    shows: ["number", "title", "from", "to"],
    outside: false,
  },
  "task.status_changed": {
    label: "A task moves",
    fields: [
      {
        key: "to",
        label: "To",
        values: TASK_STATUSES.map((s) => ({ value: s, label: s.replace("_", " ") })),
      },
    ],
    shows: ["number", "title", "from", "to"],
    outside: false,
  },
  "calendar.event_changed": {
    label: "A calendar event is added, changed or cancelled",
    fields: [
      {
        key: "change",
        label: "Change",
        values: [
          { value: "added", label: "Added" },
          { value: "updated", label: "Changed" },
          { value: "cancelled", label: "Cancelled" },
        ],
      },
    ],
    shows: ["change", "title", "startsAt", "endsAt"],
    outside: true,
  },
  "notion.task_assigned": {
    label: "A Notion ticket becomes yours",
    fields: [],
    shows: ["title", "status", "dueAt", "url"],
    outside: true,
    quiet: backfill,
  },
  "notion.task_done": {
    label: "A Notion ticket of yours is done",
    fields: [],
    shows: ["title", "status", "url"],
    outside: true,
    quiet: backfill,
  },
  "github.pr_opened": {
    label: "A pull request opens",
    fields: [REPO, AUTHOR, MINE],
    shows: ["repo", "number", "author", "url"],
    outside: true,
  },
  "github.pr_merged": {
    label: "A pull request is merged",
    fields: [REPO, AUTHOR, MINE],
    shows: ["repo", "number", "author", "url"],
    outside: true,
  },
};

export const TRIGGER_KIND_NAMES = Object.keys(TRIGGER_KINDS) as [string, ...string[]];

const norm = (v: unknown) => String(v).trim().toLowerCase();

/**
 * Whether an event's payload passes a trigger's filter: every field it names equals its value,
 * case and spaces aside. Nothing more (no patterns, no "or"), so what a trigger waits for is
 * plain to read. An empty filter passes every event of its kind.
 */
export function matches(filter: Record<string, string>, payload: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, want]) => {
    const got = payload[key];
    if (got === undefined || got === null || typeof got === "object") return false;
    return norm(got) === norm(want);
  });
}

/** What's wrong with a filter for this kind, if anything: a field it can't test, a value it can't take. */
export function filterProblem(kind: string, filter: Record<string, string>): string | null {
  const k = TRIGGER_KINDS[kind];
  if (!k) return `Triggers can't wait for ${kind}.`;
  for (const [key, value] of Object.entries(filter)) {
    const field = k.fields.find((f) => f.key === key);
    if (!field) return `"${k.label}" can't be narrowed by ${key}.`;
    if (field.values && !field.values.some((v) => v.value === norm(value)))
      return `${field.label} is one of ${field.values.map((v) => v.label).join(", ")}.`;
  }
  return null;
}

/** The lines the turn is shown about what happened: the fields its kind shows, clipped. */
export function happened(kind: string, payload: Record<string, unknown>): string[] {
  const k = TRIGGER_KINDS[kind];
  if (!k) return [];
  return k.shows.flatMap((key) => {
    const v = payload[key];
    if (v === undefined || v === null || v === "" || typeof v === "object") return [];
    return [`- ${key}: ${String(v).replace(/\s+/g, " ").slice(0, 200)}`];
  });
}
