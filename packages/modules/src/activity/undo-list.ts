// The list of what Pip did that Undo can put back, read from its events in a window (undo-read.ts
// says what each one's Undo is). Its mail changes are read apart from the rest, so a triage of a
// thousand conversations can't push a task, a memory or an event it changed out of the list.
import { isUuid, PRINCIPAL } from "@hearth/core";
import { event, type Tx } from "@hearth/db";
import { and, desc, eq, gt, gte, inArray, lt, not, notInArray, or, sql } from "drizzle-orm";
import type { UndoRef } from "./shape.ts";
import { addedUndoable, EVENT_CHANGED } from "./undo-added.ts";
import { MAIL_CHANGED, MAX_MAIL, mailUndoable } from "./undo-mail-facts.ts";
import {
  CHANGE_KINDS,
  DELETED_TYPES,
  MADE_TYPES,
  refKey,
  type Told,
  UNDONE,
  type Undoable,
  viewsOf,
} from "./undo-read.ts";

/** Events are stamped by their writer's clock, so seq order and time order can differ a little. */
const SKEW_MS = 60_000;
const MAX_CHANGES = 500;
const MAX_TOLD = 200;
/** Kinds only some of whose events have an Undo, picked out by the SQL below. */
const SOME = ["entity.created", "entity.deleted", EVENT_CHANGED];

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
  const others = await tx
    .select()
    .from(event)
    .where(
      and(
        pip(CHANGE_KINDS.filter((k) => k !== MAIL_CHANGED)),
        or(
          notInArray(event.kind, SOME),
          and(eq(event.kind, "entity.created"), inArray(type, MADE_TYPES)),
          and(eq(event.kind, "entity.deleted"), inArray(type, DELETED_TYPES), not(withParent)),
          addedUndoable,
        ),
      ),
    )
    .orderBy(desc(event.seq))
    .limit(MAX_CHANGES);
  const mail = await tx
    .select()
    .from(event)
    .where(and(pip([MAIL_CHANGED]), mailUndoable))
    .orderBy(desc(event.seq))
    .limit(MAX_MAIL);
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
  return viewsOf(tx, [...others, ...mail], told, await undoneSince(tx, edge), now);
}
