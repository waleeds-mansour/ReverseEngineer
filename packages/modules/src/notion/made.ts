// Which tasks a Notion ticket made (Connections-16). Hearth links a task it makes from a ticket as
// derived_from, which no edit of the task's words removes. Only those tasks follow the ticket:
// closed when it's done or leaves you, renamed with it. A task you wrote that mentions the ticket
// is yours. Still, no ticket that has any task at all, even one in the trash, is given another.
import type { TaskStatus } from "@hearth/core";
import { type DbOrTx, entity, link, task } from "@hearth/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

export const CLOSED: TaskStatus[] = ["completed", "canceled"];

export interface MadeTask {
  ticket: string;
  id: string;
  status: TaskStatus;
  updatedAt: Date;
}

/** The live tasks made from these tickets, oldest first. */
export async function madeTasks(db: DbOrTx, ticketIds: readonly string[]): Promise<MadeTask[]> {
  if (ticketIds.length === 0) return [];
  return db
    .select({ ticket: link.toId, id: entity.id, status: task.status, updatedAt: entity.updatedAt })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .innerJoin(task, eq(task.entityId, entity.id))
    .where(
      and(
        eq(link.kind, "derived_from"),
        inArray(link.toId, [...ticketIds]),
        isNull(entity.deletedAt),
      ),
    )
    .orderBy(asc(entity.createdAt), asc(entity.id));
}

/** Whether any task links the ticket, made or yours, open, closed or in the trash. */
export async function hasAnyTask(db: DbOrTx, ticketId: string): Promise<boolean> {
  const [one] = await db
    .select({ id: entity.id })
    .from(link)
    .innerJoin(entity, eq(entity.id, link.fromId))
    .where(and(eq(link.toId, ticketId), eq(entity.type, "task")))
    .limit(1);
  return Boolean(one);
}
