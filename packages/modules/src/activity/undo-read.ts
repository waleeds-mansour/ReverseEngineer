// What Pip did without asking that Undo can put back, read from what it left behind: the events
// its calls emitted (a record it made or moved to the trash, a task it changed, a memory it
// rewrote) and the notes the calendar keeps for what Pip did there (calendar/undo.ts). Each says
// what Pip did, what its Undo does, and why not when it can't: undone, too old, or changed since.
// Today, What Pip did and the inbox's Undo all read it here, so they always say the same.
import { isUuid, PRINCIPAL, TASK_STATUSES } from "@hearth/core";
import { event, type NotificationUndo, type Tx } from "@hearth/db";
import { and, desc, eq, gt, gte, inArray, lt, not, notInArray, or, sql } from "drizzle-orm";
import type { Since } from "../calendar/undo.ts";
import { TRASH_TYPES } from "../graph/trash.ts";
import type { UndoRef, UndoView } from "./shape.ts";
import { type Change, factsOf, TASK_KINDS } from "./undo-facts.ts";
import {
  assignedWords,
  calendarLabel,
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
/** Events are stamped by their writer's clock, so seq order and time order can differ a little. */
const SKEW_MS = 60_000;
const MAX_CHANGES = 500;
const MAX_TOLD = 200;

/** What Pip makes that Undo moves to the trash: not its own conversations, which log its work. */
const MADE_TYPES: string[] = TRASH_TYPES.filter((t) => t !== "conversation" && t !== "snippet");
const TRASHABLE = new Set<string>(TRASH_TYPES);
export const CHANGE_KINDS = ["entity.created", "entity.deleted", ...TASK_KINDS, "memory.changed"];
const STATUSES = new Set<unknown>(TASK_STATUSES);
const ASSIGNEES = new Set<unknown>([null, PRINCIPAL.owner, PRINCIPAL.jarvis]);

/** The change Undo makes, as you: one exact action, never one a stored row names. */
export interface Inverse {
  action: string;
  input: Record<string, unknown>;
}
export interface Undoable extends UndoView {
  inverse: Inverse;
  seq: number;
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

/** The last event before `since`, give or take a writer's clock: a window reads after it. */
export async function edgeOf(tx: Tx, since: Date): Promise<number> {
  const [edge] = await tx
    .select({ seq: event.seq })
    .from(event)
    .where(lt(event.at, new Date(since.getTime() - SKEW_MS)))
    .orderBy(desc(event.seq))
    .limit(1);
  return edge?.seq ?? 0;
}

/** Undo you pressed since `edge`, by what it undid. */
export async function undoneSince(tx: Tx, edge: number): Promise<Set<string>> {
  const rows = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.kind, UNDONE), gt(event.seq, edge)))
    .orderBy(desc(event.seq))
    .limit(2_000);
  const keys = rows.map((r) => r.payload.ref as UndoRef | undefined);
  return new Set(keys.flatMap((r) => (r?.kind && r.id ? [refKey(r)] : [])));
}

/**
 * Everything Pip did since `since` that Undo can put back, newest first; with `groups`, only what
 * those cards of the timeline did (their correlation ids). `edge` is edgeOf(since), when known.
 */
export async function undosOf(
  tx: Tx,
  scope: { since: Date; groups?: readonly string[]; edge?: number },
  now: Date,
): Promise<Undoable[]> {
  const edge = scope.edge ?? (await edgeOf(tx, scope.since));
  const within = scope.groups
    ? scope.groups.length
      ? inArray(event.correlationId, [...scope.groups])
      : sql`false`
    : gte(event.at, scope.since);
  const pip = (kinds: string[]) =>
    and(inArray(event.kind, kinds), gt(event.seq, edge), eq(event.actor, PRINCIPAL.jarvis), within);
  const type = sql<string>`${event.payload}->>'type'`;
  // What went to the trash under a record at the same moment comes back with it, so it isn't
  // listed: a big trash would otherwise fill the list before its own record.
  const withParent = sql`EXISTS (SELECT 1 FROM entity c JOIN event p ON p.entity_id = c.parent_id
    WHERE c.id = ${event.entityId} AND p.kind = 'entity.deleted' AND p.at = ${event.at}
    AND p.correlation_id IS NOT DISTINCT FROM ${event.correlationId})`;
  const changes = await tx
    .select()
    .from(event)
    .where(
      and(
        pip(CHANGE_KINDS),
        or(
          notInArray(event.kind, ["entity.created", "entity.deleted"]),
          and(eq(event.kind, "entity.created"), inArray(type, MADE_TYPES)),
          and(eq(event.kind, "entity.deleted"), inArray(type, [...TRASH_TYPES]), not(withParent)),
        ),
      ),
    )
    .orderBy(desc(event.seq))
    .limit(MAX_CHANGES);
  const notes = await tx
    .select()
    .from(event)
    .where(pip(["notification.created"]))
    .orderBy(desc(event.seq))
    .limit(MAX_TOLD);
  const told = notes.flatMap((e): Told[] => {
    const id = str(e.payload.notificationId);
    return id && isUuid(id) ? [{ id, groupId: e.correlationId, at: e.at, seq: e.seq }] : [];
  });
  return viewsOf(tx, changes, told, await undoneSince(tx, edge), now);
}

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
    const undid = undone.has(refKey(v.ref)) && (opts.stands ?? reality !== null);
    const old = opts.old === undefined ? WHY_NOT.old : opts.old;
    const blocked = undid
      ? WHY_NOT.undone
      : (reality ?? (old !== null && v.at.getTime() < oldBefore ? old : null));
    out.push({ tells: null, ...v, blocked, undone: undid });
  };

  for (const e of changes) {
    const rec = e.entityId ? records.get(e.entityId) : undefined;
    if (!rec || !e.entityId) continue;
    const ref: UndoRef = { kind: "event", id: e.id };
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
      finish(
        {
          ...base,
          how: "trashed",
          ...trashedWords(rec.title),
          inverse: { action: "entity.restore", input: { id: rec.id } },
        },
        reality,
        { stands: !rec.deletedAt, old: WHY_NOT.oldTrash },
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
export function shown({ inverse: _, seq: __, ...v }: Undoable): UndoView {
  return v;
}
