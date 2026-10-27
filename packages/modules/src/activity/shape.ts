// The timeline's shapes: what a card holds (a turn, its actions, approvals, what it touched and
// the heartbeat items it took up), and how a turn's row becomes the card's turn.
import { isUuid } from "@hearth/core";
import { type ApprovalStatus, heartbeatItem, jarvisTurn } from "@hearth/db";
import { clip } from "./words.ts";

export const HOW = {
  "entity.created": "made",
  "entity.updated": "changed",
  "entity.deleted": "trashed",
} as const;
export type How = (typeof HOW)[keyof typeof HOW];

/** The triggers whose prompt is your own words, so the card can quote them. */
const ASKED = new Set(["chat", "voice_command"]);

export interface TimelineTurn {
  id: string;
  trigger: string;
  mode: string;
  lane: string;
  status: string;
  outcome: string | null;
  reply: string | null;
  error: string | null;
  skipReason: string | null;
  /** What you asked, for a turn you started by typing or speaking. */
  asked: string | null;
  /** "slack" for your DM with Pip there (D62). */
  via: string | null;
  /** The routine or reflex that queued it ("brief", "jarvis.heartbeat"). */
  source: string | null;
  /** The job (role) it ran for (Spec 3). */
  roleId: string | null;
  /** The name of your trigger that set it off (Spec 6), as it was then. */
  triggerName: string | null;
  /** It started from, or went on to read, outside content (D58). */
  readOutside: boolean;
  conversationId: string | null;
  subjectId: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
}

export interface TimelineAction {
  id: string;
  at: Date;
  action: string;
  risk: string;
  outcome: "ok" | "error" | "pending_approval" | "denied";
  error: string | null;
  durationMs: number;
  approvalId: string | null;
  /** A few words for what it was about: a title, a search, the record it read. */
  what: string | null;
}

export interface TimelineApproval {
  id: string;
  action: string;
  summary: string;
  status: ApprovalStatus;
  error: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface TimelineTouched {
  id: string;
  type: string;
  title: string;
  how: How;
}

export interface TimelineItem {
  id: string;
  text: string;
  aboutId: string | null;
  createdAt: Date;
  takenAt: Date | null;
}

export interface TimelineGroup {
  /** The correlation id: the turn's id for a turn. */
  id: string;
  /** When the last thing in it happened. */
  at: Date;
  turn: TimelineTurn | null;
  actions: TimelineAction[];
  approvals: TimelineApproval[];
  touched: TimelineTouched[];
  /** Heartbeat items the turn took up. */
  setAside: TimelineItem[];
  /** What it did that Undo can put back, each with its Undo or why not (undo-read.ts). */
  undos: UndoView[];
  /** A card of its own for an Undo you pressed: "You undid: …". */
  undid: Undid | null;
}

/** What activity.undo is given: one thing Pip did, by the event it left or the calendar's note. */
export type UndoRef = { kind: "event"; id: string } | { kind: "notification"; id: string };

/** One thing Pip did without asking, and its Undo: the same on Today and in What Pip did. */
export interface UndoView {
  ref: UndoRef;
  /** The card it's on: the correlation of the call that did it. */
  groupId: string | null;
  at: Date;
  how: "made" | "trashed" | "changed";
  /** What Pip did: 'Made a task: Call the plumber'. */
  did: string;
  /** What pressing Undo does: 'Undo: move "Call the plumber" to the trash'. */
  label: string;
  /** Who pressing it tells, said beside the button: "Its organizer will see". Null for nobody. */
  tells: string | null;
  /** Why it can't be undone now (undone, too old, changed since), or null when it can. */
  blocked: string | null;
  /** You pressed its Undo, and what it put back still stands. */
  undone: boolean;
  entityId: string | null;
  entityType: string | null;
  /** Its words are outside content's (D58). */
  outside: boolean;
}

export interface Undid {
  did: string;
  entityId: string | null;
  entityType: string | null;
  /** Its words are outside content's (D58). */
  outside: boolean;
}

export interface Timeline {
  groups: TimelineGroup[];
  /** Set aside for the next heartbeat, not taken up yet (first page only). */
  waiting: TimelineItem[];
  /** Where the next page starts (its `before`), or null when this was the last. */
  next: string | null;
}

export const TURN = {
  id: jarvisTurn.id,
  trigger: jarvisTurn.trigger,
  mode: jarvisTurn.mode,
  lane: jarvisTurn.lane,
  origin: jarvisTurn.origin,
  status: jarvisTurn.status,
  outcome: jarvisTurn.outcome,
  reply: jarvisTurn.reply,
  error: jarvisTurn.error,
  skipReason: jarvisTurn.skipReason,
  prompt: jarvisTurn.prompt,
  context: jarvisTurn.context,
  conversationId: jarvisTurn.conversationId,
  subjectId: jarvisTurn.subjectId,
  queuedAt: jarvisTurn.queuedAt,
  startedAt: jarvisTurn.startedAt,
  finishedAt: jarvisTurn.finishedAt,
  durationMs: jarvisTurn.durationMs,
  roleId: jarvisTurn.roleId,
};
export type TurnRow = Pick<typeof jarvisTurn.$inferSelect, keyof typeof TURN>;

export const ITEM = {
  id: heartbeatItem.id,
  text: heartbeatItem.text,
  aboutId: heartbeatItem.aboutId,
  createdAt: heartbeatItem.createdAt,
  takenAt: heartbeatItem.takenAt,
};

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function turnOf(t: TurnRow): TimelineTurn {
  const c = t.context ?? {};
  return {
    id: t.id,
    trigger: t.trigger,
    mode: t.mode,
    lane: t.lane,
    status: t.status,
    outcome: t.outcome,
    reply: clip(t.reply, 2_000),
    error: clip(t.error, 500),
    skipReason: t.skipReason,
    asked: ASKED.has(t.trigger) ? clip(t.prompt, 300) : null,
    via: str(c.via),
    source: str(c.source),
    roleId: t.roleId,
    triggerName: t.trigger === "trigger" ? str(c.triggerName) : null,
    readOutside: t.origin === "untrusted" || c.readOutside === true,
    conversationId: t.conversationId,
    subjectId: t.subjectId,
    queuedAt: t.queuedAt,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    durationMs: t.durationMs,
  };
}

/** The ids of the heartbeat items a heartbeat turn took up (its context.itemIds). */
export const itemIdsOf = (t: TurnRow): string[] =>
  Array.isArray(t.context?.itemIds) ? t.context.itemIds.map(String).filter(isUuid) : [];

export const latest = (...dates: (Date | null | undefined)[]): number =>
  Math.max(0, ...dates.map((d) => d?.getTime() ?? 0));
