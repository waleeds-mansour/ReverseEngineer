// Your Undo of what Pip did to your mail on its own (activity/undo-mail.ts), where no other action
// puts back exactly what it changed: a trash, a move back to the inbox, and a sender sent to Signal
// or Noise. Yours only, run from activity.undo with what Pip's change recorded; none of them sends
// anything to anyone.
import { mailMessage, mailSenderRule, mailThread } from "@hearth/db";
import { type ActionContext, defineAction } from "@hearth/kernel";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import { changeFlags, recomputeThread } from "./flags.ts";
import { lane, MOVED_BACK } from "./lanes.ts";
import { senderPatterns } from "./people.ts";

const ids = z.array(id).min(1).max(500).describe("Conversation ids.");

export const mailUndoActions = [
  defineAction({
    name: "mail.untrash",
    description:
      "Undo a move to the trash: just the messages it moved there come out, and those that were in the inbox go back to it. Nothing else changes.",
    input: z.object({
      ids,
      messages: z.array(id).min(1).max(5000).describe("The messages it moved to the trash."),
      inbox: z.array(id).max(5000).default([]).describe("Those of them that were in the inbox."),
    }),
    risk: "internal",
    // Your Undo only: Pip brings mail back with mail.unarchive.
    callers: ["owner"],
    async handler(i, ctx) {
      const out = await changeFlags(ctx, i.ids, [], ["TRASH"], i.messages);
      // Back to the inbox only what was there and is out of the trash now.
      const rows = i.inbox.length
        ? await ctx.tx
            .select({ id: mailMessage.entityId, labels: mailMessage.labels })
            .from(mailMessage)
            .where(inArray(mailMessage.entityId, i.inbox))
        : [];
      const back = rows.filter((m) => !m.labels.includes("TRASH")).map((m) => m.id);
      const inbox = back.length ? await changeFlags(ctx, i.ids, ["INBOX"], [], back) : 0;
      return { changed: Math.max(out, inbox) };
    },
  }),
  defineAction({
    name: "mail.rearchive",
    description:
      "Undo a move back to the inbox: just the messages it moved there leave it again, and those that were in the trash go back to it. Nothing else changes.",
    input: z.object({
      ids,
      messages: z.array(id).max(5000).default([]).describe("The messages it moved to the inbox."),
      trash: z.array(id).max(5000).default([]).describe("Those of them that were in the trash."),
    }),
    risk: "internal",
    // Your Undo only: Pip archives with mail.archive.
    callers: ["owner"],
    async handler(i, ctx) {
      const out = i.messages.length ? await changeFlags(ctx, i.ids, [], ["INBOX"], i.messages) : 0;
      const trash = i.trash.length ? await changeFlags(ctx, i.ids, ["TRASH"], [], i.trash) : 0;
      return { changed: Math.max(out, trash) };
    },
  }),
  defineAction({
    name: "mail.lane_back",
    description:
      "Undo sending a sender to Signal or Noise: their rule goes back to what it was (or away, if there was none), and the conversations it moved go back, except those another of your rules keeps there.",
    input: z.object({
      pattern: z.string().min(1).max(320),
      lane: lane.describe("The lane it sent them to."),
      rule: lane.nullable().describe("Their rule before: a lane, or null for none."),
      threads: z.array(id).max(MOVED_BACK).default([]).describe("The conversations it moved."),
    }),
    risk: "internal",
    callers: ["owner"],
    async handler(i, ctx) {
      const where = eq(mailSenderRule.pattern, i.pattern);
      if (!i.rule) await ctx.tx.delete(mailSenderRule).where(where);
      else
        await ctx.tx
          .insert(mailSenderRule)
          .values({ pattern: i.pattern, lane: i.rule, createdAt: ctx.now })
          .onConflictDoUpdate({
            target: mailSenderRule.pattern,
            set: { lane: i.rule, createdAt: ctx.now },
          });
      // Only those still where it put them: one moved again since stays.
      const back = i.lane === "noise" ? "signal" : "noise";
      const there = i.threads.length
        ? await ctx.tx
            .select({ id: mailThread.entityId })
            .from(mailThread)
            .where(and(inArray(mailThread.entityId, i.threads), eq(mailThread.lane, i.lane)))
        : [];
      const kept = await keptThere(
        ctx,
        i,
        there.map((t) => t.id),
      );
      const still = there.filter((t) => !kept.has(t.id));
      if (still.length) {
        await ctx.tx
          .update(mailThread)
          .set({ lane: back })
          .where(
            inArray(
              mailThread.entityId,
              still.map((t) => t.id),
            ),
          );
        for (const t of still) await recomputeThread(ctx, t.id);
      }
      ctx.emit({
        kind: "mail.changed",
        payload: { lane: i.rule ?? back, moved: still.length, pattern: i.pattern },
      });
      return { pattern: i.pattern, rule: i.rule, moved: still.length };
    },
  }),
];

/**
 * The conversations another of your rules keeps in the lane Pip sent them to (one you made since,
 * say): their sender's most specific rule, as mail sorts by (people.ts ruleFor), puts them there.
 * The sender's own rule doesn't count when it was already that lane: its Undo only moves back.
 */
async function keptThere(
  ctx: ActionContext,
  i: { pattern: string; lane: string; rule: string | null },
  threads: string[],
): Promise<Set<string>> {
  if (!threads.length) return new Set();
  const from = await ctx.tx
    .select({ id: mailMessage.threadId, from: mailMessage.fromAddress })
    .from(mailMessage)
    .where(and(inArray(mailMessage.threadId, threads), eq(mailMessage.outbound, false)));
  const patterns = [...new Set(from.flatMap((m) => senderPatterns(m.from)))];
  if (!patterns.length) return new Set();
  const rules = await ctx.tx
    .select()
    .from(mailSenderRule)
    .where(
      and(
        inArray(mailSenderRule.pattern, patterns),
        i.rule === i.lane ? ne(mailSenderRule.pattern, i.pattern) : undefined,
      ),
    );
  const laneOf = new Map(rules.map((r) => [r.pattern, r.lane]));
  const ruled = (address: string) =>
    senderPatterns(address)
      .map((p) => laneOf.get(p))
      .find((l) => l !== undefined);
  return new Set(from.filter((m) => ruled(m.from) === i.lane).map((m) => m.id));
}
