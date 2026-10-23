// Catching up on tickets whose news didn't land (Connections-16): a ticket can be yours with no
// task, or done with its task still open, when making or closing the task failed, or when
// notion.to_tasks didn't run (it used to stop while Jarvis was paused). Each round finds the
// tickets out of step with their tasks and tells their news again, so notion.to_tasks puts them
// right.
import { entity, link, notionTask, task } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, eq, exists, isNotNull, isNull, lt, not, notInArray, or } from "drizzle-orm";
import { CLOSED } from "./made.ts";

type Ticket = typeof notionTask.$inferSelect & { title: string };

/**
 * Tells the news again of each of the board's tickets out of step with its task, leaving out the
 * ones told this round:
 * - yours and open, with no task at all. One you put in the trash or closed yourself is yours to
 *   keep, and one you wrote that mentions it counts too;
 * - done or gone from you, while a task made from it is still open and untouched since Hearth saw
 *   it close. A task you reopened after that stays open.
 * Returns how many were told, by kind.
 */
export async function catchUp(
  ctx: ActionContext,
  sourceId: string,
  told: ReadonlySet<string>,
  payloadOf: (t: Ticket) => Record<string, unknown>,
): Promise<{ assigned: number; done: number; unassigned: number }> {
  const out = { assigned: 0, done: 0, unassigned: 0 };
  const anyTask = ctx.tx
    .select({ id: link.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(eq(link.toId, notionTask.entityId), eq(entity.type, "task")));
  const madeStillOpen = ctx.tx
    .select({ id: link.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .innerJoin(task, eq(task.entityId, entity.id))
    .where(
      and(
        eq(link.kind, "derived_from"),
        eq(link.toId, notionTask.entityId),
        isNull(entity.deletedAt),
        notInArray(task.status, CLOSED),
        lt(entity.updatedAt, notionTask.closedAt),
      ),
    );
  const tickets = (
    await ctx.tx
      .select({ row: notionTask, title: entity.title })
      .from(notionTask)
      .innerJoin(entity, eq(entity.id, notionTask.entityId))
      .where(
        and(
          eq(notionTask.sourceId, sourceId),
          isNull(entity.deletedAt),
          or(
            and(eq(notionTask.assigned, true), eq(notionTask.done, false), not(exists(anyTask))),
            and(isNotNull(notionTask.closedAt), exists(madeStillOpen)),
          ),
        ),
      )
  )
    .map((r) => ({ ...r.row, title: r.title }))
    .filter((t) => !told.has(t.entityId));
  for (const t of tickets) {
    const kind = t.done
      ? "notion.task_done"
      : !t.assigned
        ? "notion.task_unassigned"
        : t.closedAt
          ? null
          : "notion.task_assigned";
    if (!kind) continue;
    ctx.emit({ kind, entityId: t.entityId, payload: { ...payloadOf(t), caughtUp: true } });
    if (kind === "notion.task_assigned") out.assigned++;
    else if (kind === "notion.task_done") out.done++;
    else out.unassigned++;
  }
  return out;
}
