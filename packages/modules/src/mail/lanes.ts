// Signal and Noise by sender: your rules for whose mail is worth your attention. A sender sent to
// Noise is never in People (bundles.ts): their mail goes to Updates, or Newsletters if it went to
// many, until you write in it.
import { mailMessage, mailSenderRule, mailThread } from "@hearth/db";
import { ActionError, defineAction } from "@hearth/kernel";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { recomputeThread } from "./flags.ts";
import { normalizePattern, senderPatterns } from "./people.ts";

export const lane = z.enum(["signal", "noise"]);
/** The most conversations a lane's Undo moves back. */
export const MOVED_BACK = 500;

export const laneActions = [
  defineAction({
    name: "mail.set_lane",
    description:
      "Send all mail from an address or a whole domain to Signal or Noise from now on, and move what's in the inbox from them now. Noise keeps it out of People: it goes to Updates, or Newsletters if it was sent to many.",
    input: z.object({
      sender: z
        .string()
        .min(3)
        .max(320)
        .describe('An address ("news@shop.example") or a domain ("shop.example").'),
      lane,
    }),
    risk: "internal",
    summarize: (i) => `Mail from ${i.sender} goes to ${i.lane === "noise" ? "Noise" : "Signal"}`,
    async handler(i, ctx) {
      const pattern = normalizePattern(i.sender);
      if (!pattern)
        throw new ActionError("invalid_input", "That isn't an email address or a domain.");
      const [was] = await ctx.tx
        .select({ lane: mailSenderRule.lane })
        .from(mailSenderRule)
        .where(eq(mailSenderRule.pattern, pattern))
        .for("update");
      await ctx.tx
        .insert(mailSenderRule)
        .values({ pattern, lane: i.lane, createdAt: ctx.now })
        .onConflictDoUpdate({
          target: mailSenderRule.pattern,
          set: { lane: i.lane, createdAt: ctx.now },
        });
      // Conversations in the inbox from that sender move now; ones you've written in stay Signal.
      const inbox = await ctx.tx
        .select({
          id: mailThread.entityId,
          lane: mailThread.lane,
          out: mailThread.lastOutboundAt,
          from: mailMessage.fromAddress,
        })
        .from(mailThread)
        .innerJoin(mailMessage, eq(mailMessage.threadId, mailThread.entityId))
        .where(and(eq(mailThread.inInbox, true), eq(mailMessage.outbound, false)));
      const moving = [
        ...new Set(
          inbox
            .filter((t) => t.lane !== i.lane && !(i.lane === "noise" && t.out))
            .filter((t) => senderPatterns(t.from).includes(pattern))
            .map((t) => t.id),
        ),
      ];
      if (moving.length) {
        await ctx.tx
          .update(mailThread)
          .set({ lane: i.lane })
          .where(inArray(mailThread.entityId, moving));
        // Who each one waits on depends on its lane, and so does its bundle.
        for (const id of moving) await recomputeThread(ctx, id);
      }
      // The rule before and what moved, for its Undo (mail.lane_back, activity/undo-mail.ts).
      if (moving.length || was?.lane !== i.lane)
        ctx.emit({
          kind: "mail.changed",
          payload: {
            lane: i.lane,
            moved: moving.length,
            pattern,
            was: was?.lane ?? null,
            threads: moving.slice(0, MOVED_BACK),
          },
        });
      return { pattern, lane: i.lane, moved: moving.length };
    },
  }),
  defineAction({
    name: "mail.rules",
    description: "Your Signal and Noise rules by sender.",
    input: z.object({}),
    risk: "read",
    handler: (_i, ctx) => ctx.tx.select().from(mailSenderRule).orderBy(mailSenderRule.pattern),
  }),
  defineAction({
    name: "mail.remove_rule",
    description: "Forget a Signal or Noise rule.",
    input: z.object({ pattern: z.string().min(1).max(320) }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const gone = await ctx.tx
        .delete(mailSenderRule)
        .where(eq(mailSenderRule.pattern, i.pattern))
        .returning();
      return { removed: gone.length };
    },
  }),
];
