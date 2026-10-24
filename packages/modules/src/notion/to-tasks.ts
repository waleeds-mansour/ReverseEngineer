// Your Notion tickets as Hearth tasks, kept in step without a model turn: a ticket newly yours
// becomes a task (or reopens the one it made), a done ticket closes its task, and a new title or
// due date carries over. One handed to someone else (or deleted) cancels its task. Only the task
// made from a ticket follows it (made.ts); one you wrote that mentions the ticket is yours. Nothing
// is made twice, even when a round tells a ticket's news again (catch-up.ts).
import { atLocal, renderMention } from "@hearth/core";
import { type DbOrTx, notionTask } from "@hearth/db";
import {
  ActionError,
  addLink,
  defineAction,
  getSetting,
  type ReflexDef,
  type ReflexOutcome,
} from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { id, isoDateTime, liveEntity } from "../shared.ts";
import { CLOSED, hasAnyTask, madeTasks } from "./made.ts";

/** Notion's due date as a task's: a whole day is local midnight, marked as a day. */
async function dueOf(db: DbOrTx, p: Record<string, unknown>) {
  if (typeof p.dueAt !== "string") return { dueAt: null, dueIsDate: false };
  if (!p.dueIsDate) return { dueAt: p.dueAt, dueIsDate: false };
  const { timeZone } = await getSetting(db, "owner.dayRules");
  return { dueAt: atLocal(p.dueAt.slice(0, 10), 0, timeZone).toISOString(), dueIsDate: true };
}

/** When Hearth saw the ticket close or leave you: a task touched since then stays as it is. */
async function closedAt(db: DbOrTx, ticketId: string): Promise<Date | null> {
  const [row] = await db
    .select({ closedAt: notionTask.closedAt })
    .from(notionTask)
    .where(eq(notionTask.entityId, ticketId));
  return row?.closedAt ?? null;
}

export const notionToTasks: ReflexDef = {
  name: "notion.to_tasks",
  description:
    "Tickets assigned to you on your Notion board become Nook tasks, closed when the ticket is done or goes to someone else, and kept in step with its title and due date.",
  // It makes no model turn, so it keeps your tasks in step while Jarvis is paused too. It acts as
  // Hearth on the ticket's untrusted news, keeping that origin, so what it writes is marked as
  // outside content (D58).
  mode: "always",
  on: ["notion.task_assigned", "notion.task_done", "notion.task_changed", "notion.task_unassigned"],
  async run(ev, ctx) {
    const ticketId = ev.entityId;
    const ticket = ticketId ? await liveEntity(ctx.db, ticketId, "notion_task") : undefined;
    if (!ticketId || !ticket) return [];
    const p = ev.payload;
    const made = await madeTasks(ctx.db, [ticketId]);
    const open = made.filter((m) => !CLOSED.includes(m.status));
    const update = (ids: string[], patch: Record<string, unknown>): ReflexOutcome[] =>
      ids.map((tid) => ({ kind: "act", action: "task.update", input: { id: tid, ...patch } }));
    if (ev.kind === "notion.task_done" || ev.kind === "notion.task_unassigned") {
      const status = ev.kind === "notion.task_done" ? "completed" : "canceled";
      // Told again, it closes only a task nothing touched since: one you reopened stays open.
      const since = p.caughtUp === true ? await closedAt(ctx.db, ticketId) : null;
      const closing = p.caughtUp === true ? open.filter((m) => since && m.updatedAt < since) : open;
      return update(
        closing.map((m) => m.id),
        { status },
      );
    }
    if (ev.kind === "notion.task_changed") {
      if (open.length === 0) return [];
      const changed = Array.isArray(p.changed) ? p.changed : [];
      const patch = {
        ...(changed.includes("title") ? { title: ticket.title } : {}),
        ...(changed.includes("due") ? await dueOf(ctx.db, p) : {}),
      };
      return Object.keys(patch).length
        ? update(
            open.map((m) => m.id),
            patch,
          )
        : [];
    }
    // Newly yours: the task it made comes back, or it gets one if it never had any task.
    if (made.length) return open.length ? [] : update([made.at(-1)!.id], { status: "not_started" });
    if (await hasAnyTask(ctx.db, ticketId)) return [];
    const due = await dueOf(ctx.db, p);
    return [
      {
        kind: "act",
        action: "notion.make_task",
        input: { ticketId, ...(due.dueAt ? due : {}) },
      },
    ];
  },
};

/** Makes a ticket's task, linked to it as made from it, in one go. */
export const makeTaskAction = defineAction({
  name: "notion.make_task",
  description:
    "Make the task for a Notion ticket newly yours, linked to the ticket it's made from. notion.to_tasks does this.",
  input: z.object({
    ticketId: id,
    dueAt: isoDateTime.optional(),
    dueIsDate: z.boolean().optional(),
  }),
  risk: "internal",
  callers: ["system"],
  async handler(i, ctx) {
    // Held till its task is in, so the ticket's news told twice at once still makes one task.
    await ctx.tx.select().from(notionTask).where(eq(notionTask.entityId, i.ticketId)).for("update");
    const ticket = await liveEntity(ctx.tx, i.ticketId, "notion_task");
    if (!ticket) throw new ActionError("not_found", "No such Notion ticket");
    if (await hasAnyTask(ctx.tx, i.ticketId)) return null;
    const ref = renderMention({ type: "notion_task", id: i.ticketId, label: "Notion ticket" });
    const made = await ctx.call<{ id: string }>("task.create", {
      title: ticket.title,
      body: `From ${ref}.`,
      outside: true,
      ...(i.dueAt ? { dueAt: i.dueAt, dueIsDate: i.dueIsDate ?? false } : {}),
    });
    await addLink(ctx, { fromId: made.id, toId: i.ticketId, kind: "derived_from" });
    return { id: made.id };
  },
});
