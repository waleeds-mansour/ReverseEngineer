// Undo for an event Pip put on your calendar on its own, with no guests: one it added
// (calendar.create_event) or a task's block of time (calendar.block_task). Undo takes it off
// (calendar.take_back), telling nobody, while it's still as Pip left it: no guests, and not moved
// or changed since by you or anyone. Like the calendar's other Undos, it has no age limit.
import { PRINCIPAL } from "@hearth/core";
import { calendarEvent, event, type Tx } from "@hearth/db";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Change, Record_ } from "./undo-facts.ts";
import type { Piece } from "./undo-mail-facts.ts";
import { addedWords, WHY_NOT } from "./undo-words.ts";

export const EVENT_CHANGED = "calendar.event_changed";

/** Events added to your calendar: Pip's own are read from these. */
export const addedUndoable = and(
  eq(event.kind, EVENT_CHANGED),
  sql`${event.payload} ->> 'change' = 'added'`,
);

interface Later {
  seq: number;
  kind: string;
  actor: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

export interface AddedFacts {
  rows: Map<
    string,
    { status: string; startsAt: Date; endsAt: Date; guests: number; block: boolean }
  >;
  /** Later changes to the same events, newest first, so the limit leaves out the oldest. */
  later: Later[];
}

/** How the events Pip added are now; null when there are none. */
export async function addedFactsOf(tx: Tx, changes: readonly Change[]): Promise<AddedFacts | null> {
  const added = changes.filter((e) => e.kind === EVENT_CHANGED && e.entityId);
  if (!added.length) return null;
  const ids = [...new Set(added.map((e) => e.entityId!))];
  const rows = await tx
    .select({
      id: calendarEvent.entityId,
      status: calendarEvent.status,
      startsAt: calendarEvent.startsAt,
      endsAt: calendarEvent.endsAt,
      attendees: calendarEvent.attendees,
      taskId: calendarEvent.taskId,
    })
    .from(calendarEvent)
    .where(inArray(calendarEvent.entityId, ids));
  const later = await tx
    .select({
      seq: event.seq,
      kind: event.kind,
      actor: event.actor,
      entityId: event.entityId,
      payload: event.payload,
    })
    .from(event)
    .where(
      and(
        inArray(event.entityId, ids),
        gt(event.seq, Math.min(...added.map((e) => e.seq))),
        inArray(event.kind, [EVENT_CHANGED, "entity.updated"]),
      ),
    )
    .orderBy(desc(event.seq))
    .limit(5_000);
  return {
    rows: new Map(
      rows.map((r) => [
        r.id,
        {
          status: r.status,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          guests: r.attendees.filter((a) => !a.self).length,
          block: r.taskId !== null,
        },
      ]),
    ),
    later,
  };
}

/** The Undo of an event Pip added on its own, or null when it has none. */
export function addedPiece(
  e: Change,
  rec: Record_ | undefined,
  f: AddedFacts | null,
): Piece | null {
  const p = e.payload;
  const row = rec && f?.rows.get(rec.id);
  if (!rec || !row || !f || p.change !== "added" || rec.type !== "event") return null;
  // Added with guests: a meeting you said yes to, not something Pip did on its own. One added
  // before Nook said how many it had, that has guests now, may be one too.
  if (typeof p.guests === "number" ? p.guests > 0 : row.guests > 0) return null;
  const since = f.later.filter((l) => l.entityId === rec.id && l.seq > e.seq);
  // Where Pip left it: where it added it, or where it moved it since.
  const left =
    since.find((l) => l.kind === EVENT_CHANGED && l.actor === PRINCIPAL.jarvis)?.payload ?? p;
  const others = since.filter((l) => l.actor !== PRINCIPAL.jarvis && l.actor !== PRINCIPAL.system);
  const gone = rec.deletedAt !== null || row.status === "cancelled";
  const moved =
    row.startsAt.toISOString() !== left.startsAt ||
    row.endsAt.toISOString() !== left.endsAt ||
    rec.title !== left.title;
  const reality = gone
    ? WHY_NOT.offCalendar
    : row.guests > 0
      ? WHY_NOT.guests
      : others.some((l) => l.actor === PRINCIPAL.owner)
        ? WHY_NOT.youChanged
        : others.length || moved
          ? WHY_NOT.changed
          : null;
  return {
    how: "made",
    ...addedWords(rec.title, row.block),
    inverse: { action: "calendar.take_back", input: { id: rec.id } },
    entityId: rec.id,
    entityType: rec.type,
    outside: rec.outside,
    reality,
    stands: gone,
    old: null,
  };
}
