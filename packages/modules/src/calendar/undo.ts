// Putting back what Jarvis did to your calendar on its own (D71, D72). Each FYI it leaves carries
// a closed undo, {kind, eventId, before}, that only this module writes; no action's input can set
// it. calendar.undo maps the kind to one exact change, made as you, so a stored row can never
// run anything else. Once the event has changed since (moved, put back, answered by you), Undo
// would undo that instead, so it's refused.
import { formatTime, localDate, PRINCIPAL } from "@hearth/core";
import { calendarEvent, entity, type NotificationUndo, notification, type Tx } from "@hearth/db";
import {
  type ActionContext,
  ActionError,
  createNotification,
  defineAction,
  getSetting,
} from "@hearth/kernel";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { GTime } from "../google/calendar-api.ts";
import { id } from "../shared.ts";
import { api, fields, insertEvent, patchEvent, when } from "./actions.ts";
import { writableCalendar } from "./calendars.ts";
import { answer, mustBeYours } from "./respond.ts";
import { type EventView, loadEvent } from "./store.ts";

/** "Tue 2026-10-13, 10 a.m." or "Tue 2026-10-13, all day": when an FYI says it is. */
export function shortWhen(v: Pick<EventView, "startsAt" | "allDay">, timeZone: string): string {
  const day = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(v.startsAt);
  const at = v.allDay ? "all day" : formatTime(v.startsAt, timeZone);
  return `${day} ${localDate(v.startsAt, timeZone)}, ${at}`;
}

/** Its times as the calendar's actions take them back: dates for an all-day event. */
export function timesOf(ev: Pick<EventView, "startsAt" | "endsAt" | "allDay">, timeZone: string) {
  return ev.allDay
    ? { start: localDate(ev.startsAt, timeZone), end: localDate(ev.endsAt, timeZone) }
    : { start: ev.startsAt.toISOString(), end: ev.endsAt.toISOString() };
}

/** The FYI for something Jarvis did on its own, with the one way to put it back. */
export async function tellDone(
  ctx: ActionContext,
  n: { kind: string; title: string; body: string; entityId: string; outside?: boolean },
  undo: NotificationUndo,
): Promise<void> {
  const created = await createNotification(ctx, { ...n, urgency: "normal" });
  if (created)
    await ctx.tx.update(notification).set({ undo }).where(eq(notification.id, created.id));
}

const undoShape = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("unaccept"),
    eventId: id,
    before: z.object({ scope: z.enum(["this", "all"]) }),
  }),
  z.object({
    kind: z.literal("unmove"),
    eventId: id,
    before: z.object({ start: when, end: when, when: z.string() }),
    after: z.object({ start: when, end: when }).optional(),
  }),
  z.object({
    kind: z.literal("unremove"),
    eventId: id,
    before: z.object({
      calendarId: z.string(),
      title: fields.title,
      start: when,
      end: when,
      when: z.string(),
      description: fields.description,
      location: fields.location,
    }),
  }),
]);

/** What happened to the event since Pip's change, which its Undo would undo instead. */
export type Since = "gone" | "moved" | "back" | "answered";

/** The same time, said as a day (all day) or an instant. */
const same = (a: string, b: string) =>
  a.length === 10 || b.length === 10 ? a === b : Date.parse(a) === Date.parse(b);

const EVENT_NOW = {
  id: calendarEvent.entityId,
  calendarId: calendarEvent.calendarId,
  title: entity.title,
  status: calendarEvent.status,
  startsAt: calendarEvent.startsAt,
  endsAt: calendarEvent.endsAt,
  allDay: calendarEvent.allDay,
  selfResponse: calendarEvent.selfResponse,
  jarvisAccepted: calendarEvent.jarvisAccepted,
  deletedAt: entity.deletedAt,
  updatedBy: entity.updatedBy,
};
interface EventNow {
  status: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  selfResponse: string | null;
  jarvisAccepted: boolean;
  deletedAt: Date | null;
  updatedBy: string;
}

/** Whether what Pip did still stands. A note from before Nook kept where it moved it can't tell. */
function sinceThen(u: NotificationUndo, ev: EventNow | undefined, again: boolean, tz: string) {
  const off = !ev || ev.deletedAt !== null || ev.status === "cancelled";
  if (u.kind === "unremove") return !off || again ? "back" : null;
  if (off) return "gone";
  if (u.kind === "unaccept")
    return ev.selfResponse === "accepted" && ev.jarvisAccepted ? null : "answered";
  if (!u.after) return null;
  const t = timesOf(ev, tz);
  return same(t.start, u.after.start) && same(t.end, u.after.end) ? null : "moved";
}

/**
 * For each of these undos, what happened to its event since Pip's change (null when nothing did)
 * and whether you did it. One read for a whole list.
 */
export async function sinceOf(tx: Tx, undos: readonly NotificationUndo[]) {
  const ids = [...new Set(undos.map((u) => u.eventId))];
  const now = ids.length
    ? await tx
        .select(EVENT_NOW)
        .from(calendarEvent)
        .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
        .where(inArray(calendarEvent.entityId, ids))
    : [];
  const removed = undos.flatMap((u) => (u.kind === "unremove" ? [u.before] : []));
  // Put back as a new event, the same title at the same time: Undo would add it twice.
  const live = removed.length
    ? await tx
        .select(EVENT_NOW)
        .from(calendarEvent)
        .innerJoin(entity, eq(entity.id, calendarEvent.entityId))
        .where(
          and(
            inArray(calendarEvent.calendarId, [...new Set(removed.map((b) => b.calendarId))]),
            inArray(entity.title, [...new Set(removed.map((b) => b.title))]),
            ne(calendarEvent.status, "cancelled"),
            isNull(entity.deletedAt),
          ),
        )
        .limit(500)
    : [];
  const { timeZone } = await getSetting(tx, "owner.dayRules");
  const byId = new Map(now.map((r) => [r.id, r]));
  return (u: NotificationUndo): { since: Since; byYou: boolean } | null => {
    const ev = byId.get(u.eventId);
    const again =
      u.kind === "unremove" &&
      live.some(
        (r) =>
          r.calendarId === u.before.calendarId &&
          r.title === u.before.title &&
          same(timesOf(r, timeZone).start, u.before.start),
      );
    const since = sinceThen(u, ev, again, timeZone);
    return since && { since, byYou: ev?.updatedBy === PRINCIPAL.owner };
  };
}

const REFUSED: Record<Since, string> = {
  gone: "That event isn't on your calendar any more.",
  moved: "It's been moved since, so Undo would undo that instead.",
  back: "It's back on your calendar already.",
  answered: "You've answered this invitation yourself since.",
};

/** Nook's copy is as of the last sync: a move you made at Google since counts too. */
async function stillWhereMoved(
  ctx: ActionContext,
  eventId: string,
  after: Record<"start" | "end", string>,
) {
  const ev = await loadEvent(ctx.tx, eventId);
  if (!ev) return;
  const cal = await writableCalendar(ctx, ev.calendarId);
  const g = await api(ctx).get(cal.account, cal.googleId, ev.googleId);
  const at = (t: GTime | undefined) => t?.date ?? t?.dateTime ?? "";
  if (g && !(same(at(g.start), after.start) && same(at(g.end), after.end)))
    throw new ActionError("conflict", REFUSED.moved);
}

/** Back to unanswered, unless you answered it yourself since: then there's nothing to take back. */
async function unaccept(ctx: ActionContext, eventId: string, scope: "this" | "all") {
  const ev = await loadEvent(ctx.tx, eventId);
  if (!ev || ev.status === "cancelled")
    throw new ActionError("not_found", "That meeting isn't on your calendar any more.");
  await mustBeYours(ctx.tx, ev);
  const [row] = await ctx.tx
    .select({ byJarvis: calendarEvent.jarvisAccepted })
    .from(calendarEvent)
    .where(eq(calendarEvent.entityId, ev.id));
  // Jarvis's yes only: one you gave yourself since (in Hearth) isn't its to take back.
  if (ev.selfResponse !== "accepted" || !row?.byJarvis)
    throw new ActionError("conflict", "You've answered this invitation yourself since.");
  return answer(ctx, ev, "needsAction", scope === "all" && ev.recurringEventId ? "all" : undefined);
}

export const undoAction = defineAction({
  name: "calendar.undo",
  description:
    "Put back what Pip did to the calendar on its own, from its line in the inbox. The button says exactly what it does.",
  input: z.object({ notificationId: id }),
  risk: "internal",
  // Your button only: Jarvis doesn't take back its own work behind your back.
  callers: ["owner"],
  async handler(i, ctx) {
    const [n] = await ctx.tx
      .select()
      .from(notification)
      .where(eq(notification.id, i.notificationId))
      .for("update");
    if (!n?.undo) throw new ActionError("not_found", "There's nothing to undo here any more.");
    const u = undoShape.parse(n.undo);
    const since = (await sinceOf(ctx.tx, [u]))(u);
    if (since) throw new ActionError("conflict", REFUSED[since.since]);
    if (u.kind === "unmove" && u.after) await stillWhereMoved(ctx, u.eventId, u.after);
    if (u.kind === "unaccept") await unaccept(ctx, u.eventId, u.before.scope);
    else if (u.kind === "unmove")
      await patchEvent(ctx, u.eventId, { start: u.before.start, end: u.before.end });
    else {
      const { when: _, ...event } = u.before;
      await insertEvent(ctx, event);
    }
    await ctx.tx
      .update(notification)
      .set({ undo: null, state: "done", updatedAt: ctx.now })
      .where(eq(notification.id, n.id));
    ctx.emit({
      kind: "notification.updated",
      entityId: n.entityId,
      payload: { notificationId: n.id, state: "done" },
    });
    return { undone: u.kind };
  },
});
