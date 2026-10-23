// Pip's desk, for Today: what Pip is working on now, since when and when it will be stopped if it
// hasn't finished, and what's waiting after it, in the order Pip takes them (packages/jarvis
// claim.ts). Stop is jarvis.cancel_turn. Each turn reads as the timeline's (activity/shape.ts).
import { turnLimitMs } from "@hearth/core";
import { audit, jarvisTurn } from "@hearth/db";
import { defineAction } from "@hearth/kernel";
import { and, asc, count, desc, eq, gte, inArray, like, sql } from "drizzle-orm";
import { z } from "zod";
import { type TimelineTurn, TURN, turnOf } from "../activity/shape.ts";

/** How many waiting turns the desk lists; it counts the rest. */
const LISTED = 5;
/** More running at once than this would be a runner gone wrong; the desk shows the first. */
const RUNNING = 10;

export interface DeskTurn extends TimelineTurn {
  /** Not before then: a retry waiting out its pause, say. */
  notBefore: Date;
  /** When it's stopped if it hasn't finished; null until it starts. */
  deadline: Date | null;
  /** You pressed Stop, and it's stopping. */
  stopping: boolean;
  /** It has used the browser, which gives it the browser's time. */
  browsing: boolean;
}

export interface Desk {
  running: DeskTurn[];
  waiting: DeskTurn[];
  /** How many are waiting in all, listed or not. */
  waitingCount: number;
}

const DESK = {
  ...TURN,
  notBefore: jarvisTurn.notBefore,
  cancelRequestedAt: jarvisTurn.cancelRequestedAt,
};

export const deskAction = defineAction({
  name: "jarvis.desk",
  description:
    "What Pip is working on now, since when and when it will be stopped, and what's waiting after it.",
  input: z.object({}),
  risk: "read",
  callers: ["owner"],
  async handler(_i, ctx): Promise<Desk> {
    const running = await ctx.tx
      .select(DESK)
      .from(jarvisTurn)
      .where(eq(jarvisTurn.status, "running"))
      .orderBy(asc(jarvisTurn.startedAt))
      .limit(RUNNING);
    // Yours first, then Slack members', then Pip's own work: the order claim.ts takes them in.
    const member = sql`${jarvisTurn.trigger} = 'slack_member'`;
    const waiting = await ctx.tx
      .select(DESK)
      .from(jarvisTurn)
      .where(eq(jarvisTurn.status, "queued"))
      .orderBy(
        desc(sql`${jarvisTurn.mode} = 'reactive' AND NOT ${member}`),
        desc(member),
        asc(jarvisTurn.queuedAt),
      )
      .limit(LISTED);
    const [all] =
      waiting.length < LISTED
        ? [{ n: waiting.length }]
        : await ctx.tx
            .select({ n: count() })
            .from(jarvisTurn)
            .where(eq(jarvisTurn.status, "queued"));

    // A turn that has used the browser has the browser's time (turn-budget.ts Deadline.browsing).
    const starts = running.flatMap((t) => (t.startedAt ? [t.startedAt.getTime()] : []));
    const browsed = starts.length
      ? await ctx.tx
          .selectDistinct({ id: audit.correlationId })
          .from(audit)
          .where(
            and(
              gte(audit.at, new Date(Math.min(...starts))),
              inArray(
                audit.correlationId,
                running.map((t) => t.id),
              ),
              like(audit.action, "browser.%"),
            ),
          )
      : [];
    const browsing = new Set(browsed.map((b) => b.id));

    const desk = (t: (typeof running)[number]): DeskTurn => {
      const browses = browsing.has(t.id);
      return {
        ...turnOf(t),
        notBefore: t.notBefore,
        deadline: t.startedAt ? new Date(t.startedAt.getTime() + turnLimitMs(t, browses)) : null,
        stopping: t.cancelRequestedAt !== null,
        browsing: browses,
      };
    };
    return {
      running: running.map(desk),
      waiting: waiting.map(desk),
      waitingCount: Number(all?.n ?? 0),
    };
  },
});
