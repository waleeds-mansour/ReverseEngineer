// What an Undo needs to know about the things Pip changed, as they are now: each record (in the
// trash? who changed it last, or did it just come back from the trash?), what others put under
// what Pip made, each task's fields, each memory's latest version, and the events the calendar's
// notes are about. Read in one go for a whole list (undo-read.ts).
import { PRINCIPAL } from "@hearth/core";
import {
  entity,
  event,
  memoryRevision,
  type NotificationUndo,
  notification,
  type Tx,
  task,
} from "@hearth/db";
import { getSetting } from "@hearth/kernel";
import { and, eq, gt, inArray, isNull, max } from "drizzle-orm";
import { sinceOf } from "../calendar/undo.ts";
import { FOLLOWS_PARENT } from "../graph/trash.ts";
import type { Under } from "./undo-words.ts";

export const TASK_KINDS = ["task.status_changed", "task.due_changed", "task.assigned"];

export type Change = Pick<
  typeof event.$inferSelect,
  "id" | "seq" | "at" | "kind" | "entityId" | "payload" | "correlationId"
>;

export interface Record_ {
  id: string;
  type: string;
  title: string;
  deletedAt: Date | null;
  updatedAt: Date;
  updatedBy: string;
  outside: boolean;
  parentId: string | null;
}

/** How deep under a record Undo looks for what others put there. */
const DEPTH = 20;
const pipOrNook = (by: string) => by === PRINCIPAL.jarvis || by === PRINCIPAL.system;

/** For each record, what others put under it since, which would go to the trash with it. */
async function underOf(tx: Tx, ids: readonly string[]): Promise<Map<string, Under>> {
  const out = new Map<string, Under>();
  const rootOf = new Map(ids.map((id) => [id, id]));
  let level = [...ids];
  for (let depth = 0; level.length && depth < DEPTH; depth++) {
    const rows = await tx
      .select({ id: entity.id, parentId: entity.parentId, by: entity.createdBy })
      .from(entity)
      .where(
        and(
          inArray(entity.parentId, level),
          isNull(entity.deletedAt),
          inArray(entity.type, [...FOLLOWS_PARENT]),
        ),
      )
      .limit(5_000);
    for (const r of rows) {
      const root = rootOf.get(r.parentId ?? "");
      if (!root) continue;
      if (!rootOf.has(r.id)) rootOf.set(r.id, root);
      if (pipOrNook(r.by)) continue;
      const u = out.get(root) ?? { yours: 0, others: 0 };
      if (r.by === PRINCIPAL.owner) u.yours++;
      else u.others++;
      out.set(root, u);
    }
    level = rows.map((r) => r.id);
  }
  return out;
}

/** How things are now, for the events Pip left and the calendar's notes (`noteIds`). */
export async function factsOf(tx: Tx, changes: readonly Change[], noteIds: readonly string[]) {
  const notes = noteIds.length
    ? await tx
        .select()
        .from(notification)
        .where(
          and(inArray(notification.id, [...noteIds]), eq(notification.createdBy, PRINCIPAL.jarvis)),
        )
    : [];
  const ids = [
    ...new Set([
      ...changes.flatMap((e) => (e.entityId ? [e.entityId] : [])),
      ...notes.flatMap((n) => (n.entityId ? [n.entityId] : [])),
    ]),
  ];
  const records = ids.length
    ? await tx
        .select({
          id: entity.id,
          type: entity.type,
          title: entity.title,
          deletedAt: entity.deletedAt,
          updatedAt: entity.updatedAt,
          updatedBy: entity.updatedBy,
          outside: entity.outside,
          parentId: entity.parentId,
        })
        .from(entity)
        .where(inArray(entity.id, ids))
    : [];
  const byId = new Map<string, Record_>(records.map((r) => [r.id, r]));
  // What Pip made that's here, not in the trash: what's under it, and whether you last touched it
  // only to bring it back from the trash (after its Undo, say), which isn't changing it.
  const made = [
    ...new Set(
      changes.flatMap((e) =>
        e.kind === "entity.created" && e.entityId && byId.get(e.entityId)?.deletedAt === null
          ? [e.entityId]
          : [],
      ),
    ),
  ];
  const touched = made.filter((id) => !pipOrNook(byId.get(id)!.updatedBy));
  const after = Math.min(...changes.map((e) => e.seq));
  const restores = touched.length
    ? await tx
        .select({ id: event.entityId, at: event.at })
        .from(event)
        .where(
          and(
            eq(event.kind, "entity.restored"),
            inArray(event.entityId, touched),
            gt(event.seq, after),
          ),
        )
    : [];
  const taskIds = changes.flatMap((e) =>
    TASK_KINDS.includes(e.kind) && e.entityId ? [e.entityId] : [],
  );
  const tasks = taskIds.length
    ? await tx
        .select({
          id: task.entityId,
          status: task.status,
          dueAt: task.dueAt,
          assignee: task.assignee,
        })
        .from(task)
        .where(inArray(task.entityId, taskIds))
    : [];
  const memIds = changes.flatMap((e) =>
    e.kind === "memory.changed" && e.entityId ? [e.entityId] : [],
  );
  const revisions = memIds.length
    ? await tx
        .select({ id: memoryRevision.entityId, last: max(memoryRevision.revision) })
        .from(memoryRevision)
        .where(inArray(memoryRevision.entityId, memIds))
        .groupBy(memoryRevision.entityId)
    : [];
  const undos = notes.flatMap((n) => (n.undo ? [n.undo as NotificationUndo] : []));
  const timeZone = changes.some((e) => e.kind === "task.due_changed")
    ? (await getSetting(tx, "owner.dayRules")).timeZone
    : "UTC";
  return {
    notes: new Map(notes.map((n) => [n.id, n])),
    records: byId,
    under: made.length ? await underOf(tx, made) : new Map<string, Under>(),
    restoredAt: new Set(restores.map((r) => `${r.id}|${r.at.getTime()}`)),
    tasks: new Map(tasks.map((t) => [t.id, t])),
    lastRevision: new Map(revisions.map((r) => [r.id, r.last])),
    calendarSince: undos.length ? await sinceOf(tx, undos) : () => null,
    timeZone,
  };
}
