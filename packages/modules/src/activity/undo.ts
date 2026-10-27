// Undo for what Pip did without asking (the owner, 2026-10-27: acting on its own is only OK if
// all of it can be seen and put back in one press). activity.undos lists it for Today, the
// timeline shows it on each card (and the inbox on its note, by ref), and activity.undo puts one
// thing back. The screen sends only
// which thing (the event Pip's call left, or the calendar's note); what Undo runs is worked out
// here from what Pip did, so nothing stored or sent can make it run anything else as you.
import { PRINCIPAL } from "@hearth/core";
import { entity, event, notification, type Tx } from "@hearth/db";
import { ActionError, defineAction } from "@hearth/kernel";
import { and, desc, eq, gt, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { id, isoDateTime } from "../shared.ts";
import type { TimelineGroup, UndoRef } from "./shape.ts";
import { edgeOf, undoneSince, undosOf } from "./undo-list.ts";
import { MAIL_CHANGED, MAX_MAIL, mailUndoable } from "./undo-mail-facts.ts";
import { CHANGE_KINDS, refKey, shown, UNDONE, type Undoable, viewsOf } from "./undo-read.ts";

/** How far back a call's own events can sit from the one Undo is for (a big trash, say). */
const TOGETHER = 25_000;

const ref = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), id }),
  z.object({ kind: z.literal("notification"), id }),
]);

/**
 * The one thing a ref names, with its Undo as the screens show it, or null if it has none. With
 * `lock`, what it changed is held until the press is done, so a second tab waits and then finds
 * it undone instead of putting it back twice.
 */
export async function undoableOf(
  tx: Tx,
  r: UndoRef,
  now: Date,
  lock = false,
): Promise<Undoable | null> {
  if (r.kind === "notification") {
    const q = tx
      .select({ at: notification.createdAt })
      .from(notification)
      .where(eq(notification.id, r.id));
    const [n] = lock ? await q.for("update") : await q;
    if (!n) return null;
    const edge = await edgeOf(tx, n.at);
    const [told] = await tx
      .select({ groupId: event.correlationId, seq: event.seq })
      .from(event)
      .where(
        and(
          eq(event.kind, "notification.created"),
          gt(event.seq, edge),
          eq(event.at, n.at),
          sql`${event.payload}->>'notificationId' = ${r.id}`,
        ),
      )
      .limit(1);
    const views = await viewsOf(
      tx,
      [],
      [{ id: r.id, groupId: told?.groupId ?? null, at: n.at, seq: told?.seq ?? 0 }],
      await undoneSince(tx, edge),
      now,
    );
    return views[0] ?? null;
  }
  const [e] = await tx.select().from(event).where(eq(event.id, r.id));
  if (!e || e.actor !== PRINCIPAL.jarvis || !CHANGE_KINDS.includes(e.kind)) return null;
  const mail = e.kind === MAIL_CHANGED;
  if (lock) {
    // A sender's lane has no record to hold, and one line can stand for a whole triage, so this
    // holds the Undo itself: for mail, every line of the call that did it.
    const key = mail ? `mail:${e.correlationId ?? e.id}` : refKey(r);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`undo:${key}`}))`);
  }
  if (lock && e.entityId)
    await tx.select({ id: entity.id }).from(entity).where(eq(entity.id, e.entityId)).for("update");
  // What the same call did just before: the record it made, or the one it trashed this under. For
  // mail, the rest of what it did, which may be one line with this.
  const together = !e.correlationId
    ? []
    : mail
      ? await tx
          .select()
          .from(event)
          .where(
            and(
              eq(event.correlationId, e.correlationId),
              eq(event.actor, PRINCIPAL.jarvis),
              ne(event.id, e.id),
              mailUndoable,
            ),
          )
          .orderBy(desc(event.seq))
          .limit(MAX_MAIL)
      : await tx
          .select()
          .from(event)
          .where(
            and(
              gte(event.seq, e.seq - TOGETHER),
              lt(event.seq, e.seq),
              eq(event.correlationId, e.correlationId),
              eq(event.at, e.at),
              inArray(event.kind, ["entity.created", "entity.deleted"]),
            ),
          );
  const edge = await edgeOf(tx, e.at);
  const views = await viewsOf(tx, [e, ...together], [], await undoneSince(tx, edge), now);
  const is = (v: Undoable) => v.ref.id === e.id || !!v.members?.includes(e.id);
  return views.find((v) => v.ref.kind === "event" && is(v)) ?? null;
}

/** Each Undo you pressed in the window, as a card of its own: "You undid: …". */
export async function undidGroups(
  tx: Tx,
  edge: number,
  since: Date,
  before: Date | undefined,
): Promise<TimelineGroup[]> {
  const rows = await tx
    .select()
    .from(event)
    .where(
      and(
        eq(event.kind, UNDONE),
        gt(event.seq, edge),
        gte(event.at, since),
        before ? lt(event.at, before) : undefined,
      ),
    )
    .orderBy(desc(event.seq))
    .limit(100);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    turn: null,
    actions: [],
    approvals: [],
    touched: [],
    setAside: [],
    undos: [],
    undid: {
      did: str(r.payload.did) ?? "something Pip did",
      entityId: r.entityId,
      entityType: str(r.payload.type),
      outside: r.payload.outside === true,
    },
  }));
}

export const undoActions = [
  defineAction({
    name: "activity.undos",
    description:
      "What Pip did without asking since a time that Undo can put back, newest first: each with the words of its Undo, or why it can't be undone any more. With ref instead, just that one (none if it has no Undo).",
    input: z
      .object({ since: isoDateTime.optional(), ref: ref.optional() })
      .refine((v) => !v.since !== !v.ref, "Pass since or ref"),
    risk: "read",
    callers: ["owner"],
    async handler(i, ctx) {
      if (i.ref) {
        const u = await undoableOf(ctx.tx, i.ref, ctx.now);
        return u ? [shown(u)] : [];
      }
      return (await undosOf(ctx.tx, { since: new Date(i.since!) }, ctx.now)).map(shown);
    },
  }),
  defineAction({
    name: "activity.undo",
    description:
      "Put back one thing Pip did without asking, from its line on Today or in What Pip did: move what it made to the trash, bring back what it trashed, put a task, a memory or a conversation back as it was, take an event it added off your calendar, or the calendar's own Undo. It never sends anything. The button says exactly what it does.",
    input: z.object({ ref }),
    risk: "internal",
    // Your button only: Pip doesn't take back its own work behind your back.
    callers: ["owner"],
    async handler(i, ctx) {
      const u = await undoableOf(ctx.tx, i.ref, ctx.now, true);
      if (!u) throw new ActionError("not_found", "There's nothing to undo here.");
      if (u.blocked)
        throw new ActionError(
          "conflict",
          u.undone ? "You've undone this already." : `${u.blocked}.`,
        );
      // One line for many conversations puts back each of them still as Pip left them.
      for (const inv of [u.inverse].flat()) await ctx.call(inv.action, inv.input);
      ctx.emit({
        kind: UNDONE,
        entityId: u.entityId,
        // Its words may be outside content's, which whatever reacts to it must wrap (D58).
        payload: {
          ref: u.ref,
          did: u.did,
          type: u.entityType,
          ...(u.outside ? { outside: true } : {}),
        },
      });
      return { did: u.did };
    },
  }),
];
