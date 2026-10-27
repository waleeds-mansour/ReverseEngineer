// Your Undo of an event Pip put on your calendar on its own, with no guests (create_event, or a
// task's block): it comes off only while it still has no guests, in Nook and at Google, and is
// where Pip put it, and Google is told to send nobody anything (activity/undo-added.ts). A task's
// block you took back stays off: the planner leaves that task be until its due date or estimate
// changes (blocks.ts).
import { PRINCIPAL } from "@hearth/core";
import { entity } from "@hearth/db";
import { ActionError, defineAction, getSetting } from "@hearth/kernel";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { GTime } from "../google/calendar-api.ts";
import { id } from "../shared.ts";
import { api, removeEvent } from "./actions.ts";
import { BLOCK_TAKEN_BACK } from "./blocks.ts";
import { writableCalendar } from "./calendars.ts";
import { guests, loadEvent } from "./store.ts";
import { same, timesOf } from "./undo.ts";

export const takeBackAction = defineAction({
  name: "calendar.take_back",
  description:
    "Undo an event Pip put on your calendar on its own: it comes off, only while it has no guests and is where Pip put it. Nobody is told.",
  input: z.object({ id }),
  risk: "self_external",
  // Your Undo only: Pip removes its own events with calendar.delete_event.
  callers: ["owner"],
  async handler(i, ctx) {
    const ev = await loadEvent(ctx.tx, i.id);
    if (!ev || ev.status === "cancelled")
      throw new ActionError("not_found", "That event isn't on your calendar any more.");
    const [made] = await ctx.tx
      .select({ by: entity.createdBy })
      .from(entity)
      .where(eq(entity.id, ev.id));
    if (made?.by !== PRINCIPAL.jarvis)
      throw new ActionError("forbidden", "Pip didn't put this event on your calendar.");
    const withGuests = () =>
      new ActionError("conflict", "It has guests now, so taking it off would tell them.");
    if (guests(ev).length > 0) throw withGuests();
    // Nook's copy is as of the last sync: guests added or a move made at Google since count too.
    const cal = await writableCalendar(ctx, ev.calendarId);
    const g = await api(ctx).get(cal.account, cal.googleId, ev.googleId);
    if (!g || g.status === "cancelled")
      throw new ActionError("not_found", "Google Calendar no longer has this event.");
    if ((g.attendees ?? []).some((a) => !a.self)) throw withGuests();
    const { timeZone } = await getSetting(ctx.tx, "owner.dayRules");
    const t = timesOf(ev, timeZone);
    const at = (x: GTime | undefined) => x?.date ?? x?.dateTime ?? "";
    if (!same(at(g.start), t.start) || !same(at(g.end), t.end))
      throw new ActionError("conflict", "It's been moved since, so Undo would undo that instead.");
    if ((g.summary ?? "").trim() !== ev.title.trim())
      throw new ActionError("conflict", "It's been renamed since, so Undo would undo that too.");
    if (ev.taskId)
      ctx.emit({ kind: BLOCK_TAKEN_BACK, entityId: ev.taskId, payload: { event: ev.id } });
    // Without guests, removeEvent asks Google to send no updates.
    return removeEvent(ctx, ev.id);
  },
});
