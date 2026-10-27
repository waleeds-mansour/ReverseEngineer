// What Pip did without asking that Undo can put back, read from what it left behind: the events
// its calls emitted (a record it made or moved to the trash, a draft it threw away, a task it
// changed, a memory it rewrote, mail it triaged, an event it added) and the notes the calendar
// keeps for what Pip did there (calendar/undo.ts). Each says
// what Pip did, what its Undo does, and why not when it can't: undone, too old, or changed since.
// Today, What Pip did and the inbox's Undo all read it here, so they always say the same; the
// list of them is read in undo-list.ts.
import { PRINCIPAL, TASK_STATUSES } from "@hearth/core";
import type { NotificationUndo, Tx } from "@hearth/db";
import type { Since } from "../calendar/undo.ts";
import { TRASH_TYPES } from "../graph/trash.ts";
import type { UndoRef, UndoView } from "./shape.ts";
import { addedPiece, EVENT_CHANGED } from "./undo-added.ts";
import { type Change, factsOf, TASK_KINDS } from "./undo-facts.ts";
import { grouped } from "./undo-group.ts";
import { mailPiece } from "./undo-mail.ts";
import { MAIL_CHANGED, type Piece } from "./undo-mail-facts.ts";
import {
  assignedWords,
  calendarLabel,
  discardWords,
  dueWords,
  madeWords,
  memoryWords,
  ORGANIZER_SEES,
  statusWords,
  trashedWords,
  WHY_NOT,
} from "./undo-words.ts";

/**
 * How long Undo stays here: after a week, what Pip did is how things are. Not for the calendar's
 * notes, whose Undo is good while the event still is as Pip left it (a yes to a meeting weeks out).
 */
export const UNDO_DAYS = 7;
/** The event an Undo you pressed leaves: what the timeline shows as "You undid". */
export const UNDONE = "activity.undone";

/** What Pip makes that Undo moves to the trash: not its own conversations, which log its work. */
export const MADE_TYPES: string[] = TRASH_TYPES.filter(
  (t) => t !== "conversation" && t !== "snippet",
);
/** What Pip trashed that Undo brings back: what the Trash lists, and a draft it threw away. */
export const DELETED_TYPES: string[] = [...TRASH_TYPES, "email_draft"];
const TRASHABLE = new Set<string>(DELETED_TYPES);
export const CHANGE_KINDS = [
  "entity.created",
  "entity.deleted",
  ...TASK_KINDS,
  "memory.changed",
  MAIL_CHANGED,
  EVENT_CHANGED,
];
const STATUSES = new Set<unknown>(TASK_STATUSES);
const ASSIGNEES = new Set<unknown>([null, PRINCIPAL.owner, PRINCIPAL.jarvis]);

/** The change Undo makes, as you: one exact action, never one a stored row names. */
export interface Inverse {
  action: string;
  input: Record<string, unknown>;
}
export interface Undoable extends UndoView {
  /** One change, or one for each conversation of a line that stands for many. */
  inverse: Inverse | Inverse[];
  seq: number;
  /** For a line that stands for many: the event each one's change left. */
  members?: string[];
}

export type { Change };
/** A note the calendar left with an Undo, and the call that left it. */
export interface Told {
  id: string;
  groupId: string | null;
  at: Date;
  seq: number;
}

export const refKey = (r: UndoRef) => `${r.kind}:${r.id}`;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** Why the calendar's Undo can't any more: the event changed since Pip's change. */
const CALENDAR_SINCE: Record<Since, (byYou: boolean) => string> = {
  gone: () => WHY_NOT.offCalendar,
  moved: (byYou) => (byYou ? WHY_NOT.youChanged : WHY_NOT.changed),
  back: () => WHY_NOT.backOnCalendar,
  answered: () => WHY_NOT.answered,
};

/** Who changed it last, if that stops Undo: you or someone else, but not Pip or Nook itself. */
function changedBy(by: string): string | null {
  if (by === PRINCIPAL.jarvis || by === PRINCIPAL.system) return null;
  return by === PRINCIPAL.owner ? WHY_NOT.youChanged : WHY_NOT.changed;
}

/** What Undo would do for each change and note, with why not when it can't. */
export async function viewsOf(
  tx: Tx,
  changes: readonly Change[],
  told: readonly Told[],
  undone: ReadonlySet<string>,
  now: Date,
): Promise<Undoable[]> {
  const facts = await factsOf(
    tx,
    changes,
    told.map((t) => t.id),
  );
  const { notes, records, tasks, lastRevision, timeZone } = facts;
  const key = (e: Change, id: string | null) => `${e.correlationId}|${e.at.getTime()}|${id}`;
  // A task's fields set as it was made are part of making it, whose Undo takes it all back.
  const made = new Set(
    changes.filter((e) => e.kind === "entity.created").map((e) => key(e, e.entityId)),
  );
  // What went to the trash with a record comes back with it, so only the record has an Undo.
  const trashed = new Set(
    changes.filter((e) => e.kind === "entity.deleted").map((e) => key(e, e.entityId)),
  );
  const oldBefore = now.getTime() - UNDO_DAYS * 86_400_000;
  const seen = new Set<string>();
  const out: Undoable[] = [];

  /**
   * `reality`: why what Pip did no longer stands, or null. `stands`: whether what Undo put back
   * still does, so a pressed Undo reads "Undone" only until it's changed again (brought back from
   * the trash, say, when its Undo is good again). `old`: why not once it's too old, or null when
   * age doesn't matter.
   */
  const finish = (
    v: Omit<Undoable, "blocked" | "undone" | "tells"> & { tells?: string | null },
    reality: string | null,
    opts: { stands?: boolean; old?: string | null } = {},
  ) => {
    const pressed =
      undone.has(refKey(v.ref)) || !!v.members?.some((id) => undone.has(`event:${id}`));
    const undid = pressed && (opts.stands ?? reality !== null);
    const old = opts.old === undefined ? WHY_NOT.old : opts.old;
    const blocked = undid
      ? WHY_NOT.undone
      : (reality ?? (old !== null && v.at.getTime() < oldBefore ? old : null));
    out.push({ tells: null, ...v, blocked, undone: undid });
  };
  const finishPiece = (e: Change, piece: Piece, members?: string[]) => {
    const { reality, stands, old, op: _, ...v } = piece;
    const ref: UndoRef = { kind: "event", id: e.id };
    const at = { ref, groupId: e.correlationId, at: e.at, seq: e.seq, ...(members && { members }) };
    finish({ ...at, ...v }, reality, { stands, old });
  };
  const mail: { e: Change; piece: Piece }[] = [];

  for (const e of changes) {
    const rec = e.entityId ? records.get(e.entityId) : undefined;
    const ref: UndoRef = { kind: "event", id: e.id };
    // Mail Pip changed (a sender's lane has no record), put together below, and events it added.
    if (e.kind === MAIL_CHANGED) {
      const piece = mailPiece(e, rec, facts.mail, now);
      if (piece) mail.push({ e, piece });
      continue;
    }
    if (e.kind === EVENT_CHANGED) {
      const piece = addedPiece(e, rec, facts.added);
      if (piece) finishPiece(e, piece);
      continue;
    }
    if (!rec || !e.entityId) continue;
    const base = {
      ref,
      groupId: e.correlationId,
      at: e.at,
      seq: e.seq,
      entityId: rec.id,
      entityType: rec.type,
      outside: rec.outside,
    };
    const live = rec.deletedAt ? WHY_NOT.inTrash : null;
    const p = e.payload;
    if (e.kind === "entity.created") {
      if (!MADE_TYPES.includes(rec.type)) continue;
      // Last touched only to come back from the trash isn't changed since.
      const back = facts.restoredAt.has(`${rec.id}|${rec.updatedAt.getTime()}`);
      finish(
        {
          ...base,
          how: "made",
          ...madeWords(rec.type, rec.title, facts.under.get(rec.id)),
          inverse: { action: "entity.trash", input: { id: rec.id } },
        },
        live ?? (back ? null : changedBy(rec.updatedBy)),
        { stands: rec.deletedAt !== null },
      );
    } else if (e.kind === "entity.deleted") {
      if (!TRASHABLE.has(rec.type) || (rec.parentId && trashed.has(key(e, rec.parentId)))) continue;
      const reality = !rec.deletedAt
        ? WHY_NOT.back
        : rec.deletedAt.getTime() !== e.at.getTime()
          ? WHY_NOT.changed
          : null;
      // The Trash doesn't list drafts, so a week on it's just too old.
      const draft = rec.type === "email_draft";
      finish(
        {
          ...base,
          how: "trashed",
          ...(draft ? discardWords(rec.title) : trashedWords(rec.title)),
          inverse: { action: "entity.restore", input: { id: rec.id } },
        },
        reality,
        { stands: !rec.deletedAt, old: draft ? WHY_NOT.old : WHY_NOT.oldTrash },
      );
    } else if (TASK_KINDS.includes(e.kind)) {
      const t = tasks.get(rec.id);
      if (!t || made.has(key(e, rec.id))) continue;
      const from = p.from ?? null;
      const to = p.to ?? null;
      const current =
        e.kind === "task.status_changed"
          ? t.status
          : e.kind === "task.assigned"
            ? t.assignee
            : (t.dueAt?.toISOString() ?? null);
      const valid =
        e.kind === "task.status_changed"
          ? STATUSES.has(from)
          : e.kind === "task.assigned"
            ? ASSIGNEES.has(from)
            : from === null || (typeof from === "string" && !Number.isNaN(Date.parse(from)));
      if (!valid) continue;
      const field =
        e.kind === "task.status_changed"
          ? "status"
          : e.kind === "task.assigned"
            ? "assignee"
            : "dueAt";
      // Whether each due date was a whole day; not known for one changed before Nook kept it.
      const isDate = (v: unknown) => (typeof v === "boolean" ? v : undefined);
      const fromIsDate = isDate(p.fromIsDate);
      const words =
        e.kind === "task.status_changed"
          ? statusWords(rec.title, from, to)
          : e.kind === "task.assigned"
            ? assignedWords(rec.title, str(from), str(to))
            : dueWords(
                rec.title,
                { at: str(from), isDate: fromIsDate },
                { at: str(to), isDate: isDate(p.toIsDate) },
                timeZone,
              );
      const input: Record<string, unknown> = { id: rec.id, [field]: from };
      if (field === "dueAt" && fromIsDate !== undefined) input.dueIsDate = fromIsDate;
      finish(
        { ...base, how: "changed", ...words, inverse: { action: "task.update", input } },
        live ?? (current !== to ? (changedBy(rec.updatedBy) ?? WHY_NOT.changed) : null),
        { stands: current === from },
      );
    } else if (e.kind === "memory.changed") {
      const revision = typeof p.revision === "number" ? p.revision : 0;
      // The first version is the note being made, whose Undo is the trash.
      if (revision < 2 || seen.has(`${rec.id}|${revision}`)) continue;
      seen.add(`${rec.id}|${revision}`);
      const last = lastRevision.get(rec.id);
      finish(
        {
          ...base,
          how: "changed",
          ...memoryWords(rec.title),
          inverse: { action: "memory.revert", input: { id: rec.id, revision: revision - 1 } },
        },
        live ?? (last !== revision ? (changedBy(rec.updatedBy) ?? WHY_NOT.changed) : null),
      );
    }
  }

  // One call's mail changes done the same way are one line, with one Undo (undo-group.ts), on its
  // first change: the call's later ones don't move it.
  const same = new Map<string, { e: Change; piece: Piece }[]>();
  for (const m of mail) {
    const k = m.e.correlationId && m.piece.op ? `${m.e.correlationId}|${m.piece.op}` : m.e.id;
    const list = same.get(k);
    if (list) list.push(m);
    else same.set(k, [m]);
  }
  for (const ms of same.values()) {
    if (ms.length === 1) {
      finishPiece(ms[0]!.e, ms[0]!.piece);
      continue;
    }
    const first = ms.reduce((a, b) => (b.e.seq < a.e.seq ? b : a));
    const members = ms.map((m) => m.e.id);
    finishPiece(first.e, grouped(ms.map((m) => m.piece)), members);
  }

  for (const t of told) {
    const n = notes.get(t.id);
    const ref: UndoRef = { kind: "notification", id: t.id };
    // Only a note that came with an Undo: one taken back has none left, but says it was.
    if (!n || (!n.undo && !undone.has(refKey(ref)))) continue;
    const rec = n.entityId ? records.get(n.entityId) : undefined;
    const undo = n.undo as NotificationUndo | null;
    const since = undo ? facts.calendarSince(undo) : null;
    finish(
      {
        ref,
        groupId: t.groupId,
        at: t.at,
        seq: t.seq,
        how: "changed",
        did: n.title,
        label: undo ? calendarLabel(undo, rec?.title ?? null) : "Undo",
        tells: undo?.kind === "unaccept" ? ORGANIZER_SEES : null,
        entityId: n.entityId,
        entityType: rec?.type ?? null,
        outside: n.outside,
        inverse: { action: "calendar.undo", input: { notificationId: n.id } },
      },
      !undo ? WHY_NOT.undone : since && CALENDAR_SINCE[since.since](since.byYou),
      { old: null },
    );
  }
  return out.sort((a, b) => b.at.getTime() - a.at.getTime() || b.seq - a.seq);
}

/** A view as the screens get it: what Undo would run stays here. */
export function shown({ inverse: _, seq: __, members: ___, ...v }: Undoable): UndoView {
  return v;
}
