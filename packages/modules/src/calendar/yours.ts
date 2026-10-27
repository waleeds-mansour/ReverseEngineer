// Changing or removing one of your own events, with no guests: nobody else sees it, so Pip does it
// without asking, even in work it started itself after reading an email (the owner, 2026-10-27).
// After outside content it changes only an event on your own calendar that has no guests at
// Google as it runs, and each change leaves a line in your inbox with Undo, as D72's do.
import {
  type ActionContext,
  ActionError,
  createNotification,
  defineAction,
  getSetting,
} from "@hearth/kernel";
import { z } from "zod";
import { id } from "../shared.ts";
import { api, fields, patchEvent, plainTitle, removeEvent, when } from "./actions.ts";
import { isOwnCalendar, writableCalendar } from "./calendars.ts";
import { type EventView, guests, loadEvent } from "./store.ts";
import { shortWhen, tellDone, timesOf } from "./undo.ts";

/** Pip on its own after reading outside content: what it changes then, it tells you of. */
const afterOutside = (ctx: ActionContext) =>
  ctx.caller.kind === "agent" && ctx.caller.origin === "untrusted";

/** Why it didn't ask. */
const WHY = "It's your own event with no guests, so Pip changed it without asking.";

/**
 * The event, if Pip may change it after reading outside content: on your own calendar, with no
 * guests even at Google now (Nook's copy is as of the last sync). Anything else other people would
 * see, so it's refused, with the action that asks.
 */
async function nobodyElse(ctx: ActionContext, eventId: string, asks: string): Promise<EventView> {
  const withGuests = () =>
    new ActionError(
      "forbidden",
      `This event has guests, so changing it notifies them. Use ${asks}, which asks the owner first.`,
    );
  const ev = await loadEvent(ctx.tx, eventId);
  if (!ev || ev.status === "cancelled") throw new ActionError("not_found", "Event not found");
  if (guests(ev).length > 0) throw withGuests();
  if (!(await isOwnCalendar(ctx.tx, ev.calendarId)))
    throw new ActionError(
      "forbidden",
      "This event is on a calendar other people see, so Pip doesn't change it after reading outside content. Tell the owner instead.",
    );
  const cal = await writableCalendar(ctx, ev.calendarId);
  const now = await api(ctx).get(cal.account, cal.googleId, ev.googleId);
  if (!now || now.status === "cancelled")
    throw new ActionError("not_found", "Google Calendar no longer has this event.");
  if ((now.attendees ?? []).some((a) => !a.self)) throw withGuests();
  return ev;
}

export const yourEventActions = [
  defineAction({
    name: "calendar.update_event",
    description:
      "Move or change one of the owner's own events (no guests), without asking. For meetings with guests use calendar_update_meeting, which asks.",
    input: z.object({
      id,
      title: fields.title.optional(),
      start: when.optional(),
      end: when.optional(),
      description: fields.description,
      location: fields.location,
    }),
    risk: "self_external",
    ownWorld: true,
    async handler({ id: eid, ...patch }, ctx) {
      if (!afterOutside(ctx)) return patchEvent(ctx, eid, patch);
      const ev = await nobodyElse(ctx, eid, "calendar_update_meeting");
      const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
      const before = { ...timesOf(ev, timeZone), when: shortWhen(ev, timeZone) };
      const changed = await patchEvent(ctx, ev.id, patch);
      const at = shortWhen(changed, timeZone);
      // Its title is the email's words, as the turn read them.
      if (!patch.start && !patch.end) {
        const title = `Changed ${plainTitle(changed.title)}, ${at}`;
        await createNotification(ctx, {
          kind: "calendar.changed",
          title,
          body: WHY,
          entityId: ev.id,
          outside: true,
        });
        return changed;
      }
      const was = `It was ${before.when}${before.when.endsWith(".") ? "" : "."}`;
      await tellDone(
        ctx,
        {
          kind: "calendar.moved",
          title: `Moved ${plainTitle(changed.title)} to ${at}`,
          body: `${WHY} ${was}`,
          entityId: ev.id,
          outside: true,
        },
        { kind: "unmove", eventId: ev.id, before, after: timesOf(changed, timeZone) },
      );
      return changed;
    },
  }),
  defineAction({
    name: "calendar.delete_event",
    description:
      "Remove one of the owner's own events (no guests) from their calendar, without asking. For meetings with guests use calendar_cancel_meeting, which asks.",
    input: z.object({ id }),
    risk: "self_external",
    ownWorld: true,
    async handler(i, ctx) {
      if (!afterOutside(ctx)) return removeEvent(ctx, i.id);
      const ev = await nobodyElse(ctx, i.id, "calendar_cancel_meeting");
      const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
      const at = shortWhen(ev, timeZone);
      const done = await removeEvent(ctx, ev.id);
      await tellDone(
        ctx,
        {
          kind: "calendar.removed",
          title: `Removed ${plainTitle(ev.title)}, ${at}`,
          body: WHY.replace("changed", "removed"),
          entityId: ev.id,
          outside: true,
        },
        {
          kind: "unremove",
          eventId: ev.id,
          before: {
            calendarId: ev.calendarId,
            title: ev.title,
            ...timesOf(ev, timeZone),
            when: at,
            ...(ev.description ? { description: ev.description } : {}),
            ...(ev.location ? { location: ev.location } : {}),
          },
        },
      );
      return done;
    },
  }),
];
