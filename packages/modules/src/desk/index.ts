// The desk (D84): the desktop app's inbox, answered from the keyboard. Approve or deny what Pip
// asks, answer its questions, clear finished work, or send one of the replies Pip offers after it.
//
// These actions answer only the desktop app, and only while Windows Hello has its desk open. The
// server's sign-in check, which alone knows the app's token, sets `desk` on the app's caller then
// (apps/server/src/auth/desk.ts), and the kernel hands that caller to each action as ctx.caller:
// so the desk's state reaches them with nothing else to pass, and no other caller can claim it.
// Each action checks it before anything else. They're the owner's only, so Pip never has them as
// tools, and a browser signed in as you uses the inbox and POST /api/approvals/:id instead.
import { approval, notification, question } from "@hearth/db";
import {
  ActionError,
  type Caller,
  defineAction,
  defineModule,
  type ExecuteResult,
  type Kernel,
} from "@hearth/kernel";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { live } from "../inbox/index.ts";
import { answerQuestion } from "../questions/index.ts";
import { id } from "../shared.ts";
import { cardQuestion, deskCards, isDeskKind, MAX_CARDS, openQuestion } from "./cards.ts";
import { deskConversation } from "./conversation.ts";
import { cardReplies } from "./replies.ts";

export const DESK_SERVICE = "desk";

/** What deciding from the desk needs of the kernel, which an action can't reach by itself. */
export interface DeskDecisions {
  decide(approvalId: string, decision: "approve" | "deny", caller: Caller): Promise<ExecuteResult>;
}

/**
 * The decision POST /api/approvals/:id makes, through the same resolveApproval, but never with
 * Always allow: a rule written at the desk would outlast the sitting Windows Hello opened it for.
 */
export const deskDecisions = (kernel: Pick<Kernel, "decideApproval">): DeskDecisions => ({
  decide: (approvalId, decision, caller) =>
    kernel.decideApproval(approvalId, decision, caller, { alwaysAllow: false }),
});

const CLOSED = "Open Nook's desk with Windows Hello first.";
const NEEDS_DECISION = "This one needs a yes or a no first.";
const NEEDS_ANSWER = "Pip is waiting for an answer to this one first.";
const STALE = "Those replies aren't offered any more. Open it in Hearth to see where things are.";

/** Refuses anyone but the desktop app with its desk open. */
function atTheDesk(caller: Caller) {
  if (caller.kind !== "owner" || caller.via !== "device" || caller.desk !== true)
    throw new ActionError("forbidden", CLOSED);
}

/** What came of a decision, as the desk's own result or refusal. */
function decided(r: ExecuteResult, decision: "approve" | "deny") {
  // Only the outcome: what the approved action returned stays in Nook, not on the desktop.
  if (r.status === "ok") return { decision: decision === "approve" ? "approved" : "denied" };
  if (r.status === "error") throw new ActionError(r.code, r.message);
  throw new ActionError("forbidden", r.status === "denied" ? r.reason : CLOSED);
}

export const deskModule = defineModule({
  name: "desk",
  description:
    "The desktop app's inbox, opened with Windows Hello: approve, deny, answer and clear from the keyboard.",
  entityTypes: [],
  events: [],
  kernelEvents: ["notification.updated", "approval.resolved"],
  knowledge: {},
  reflexes: [],
  noReflexesBecause:
    "It only answers the desktop app. What its actions change, the inbox and approvals already react to.",
  actions: [
    defineAction({
      name: "desk.list",
      description:
        "The desk's cards, newest first: what Pip asks, its questions, finished work, the brief and your day, a short line each, with how many of each wait.",
      input: z.object({ limit: z.number().int().min(1).max(MAX_CARDS).default(MAX_CARDS) }),
      risk: "read",
      callers: ["owner"],
      // Your own reads leave no audit row (D56); the device's would, on every look at the desk.
      // A refused look still does.
      auditWhen: () => false,
      async handler(i, ctx) {
        atTheDesk(ctx.caller);
        return deskCards(ctx.tx, ctx.now, i.limit);
      },
    }),
    defineAction({
      name: "desk.decide",
      description: "Approve or deny what Pip asks, from the desk. Never Always allow.",
      // Strict, so a desk asking for Always allow is told no rather than given a plain yes.
      input: z.strictObject({ approvalId: id, decision: z.enum(["approve", "deny"]) }),
      risk: "internal",
      callers: ["owner"],
      // A yes runs the approved action in transactions of its own; holding one open here as well
      // would keep a connection waiting on them.
      io: true,
      // Its audit row stays with the approval, and says the decision came from the desk.
      auditApproval: (i) => i.approvalId,
      async handler(i, ctx) {
        atTheDesk(ctx.caller);
        const desk = ctx.service<DeskDecisions>(DESK_SERVICE);
        return decided(await desk.decide(i.approvalId, i.decision, ctx.caller), i.decision);
      },
    }),
    defineAction({
      name: "desk.mark",
      description:
        "Mark a desk card seen or done, as the inbox does. What waits for a yes or no, or for an answer, is done only once it's had one; a card that's done stays done.",
      input: z.object({ id, state: z.enum(["seen", "done"]) }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        atTheDesk(ctx.caller);
        const [card] = await ctx.tx
          .select({
            kind: notification.kind,
            approvalStatus: approval.status,
            asking: openQuestion(ctx.now),
          })
          .from(notification)
          .leftJoin(approval, eq(approval.id, notification.approvalId))
          .leftJoin(question, cardQuestion)
          .where(eq(notification.id, i.id));
        // Only the desk's own cards: the rest of the inbox stays out of the token's reach.
        if (!card || !isDeskKind(card.kind))
          throw new ActionError("not_found", "That card isn't on the desk.");
        if (i.state === "done") {
          // The inbox's own rule (D58), said out loud: inbox.mark alone would quietly skip it.
          const waiting = card.approvalStatus === "pending" || card.approvalStatus === "executing";
          if (waiting) throw new ActionError("conflict", NEEDS_DECISION);
          // An open question is put away by answering it (D85), or by its running out.
          if (card.asking === true) throw new ActionError("conflict", NEEDS_ANSWER);
          return ctx.call<{ updated: number }>("inbox.mark", { ids: [i.id], state: "done" });
        }
        // Seen only moves an unseen card: one that's done, here or on another screen, stays done.
        const rows = await ctx.tx
          .update(notification)
          .set({ state: "seen", updatedAt: ctx.now })
          .where(and(eq(notification.id, i.id), eq(notification.state, "unseen")))
          .returning({ id: notification.id, entityId: notification.entityId });
        for (const r of rows)
          ctx.emit({
            kind: "notification.updated",
            entityId: r.entityId,
            payload: { notificationId: r.id, state: "seen" },
          });
        return { updated: rows.length };
      },
    }),
    defineAction({
      name: "desk.answer",
      description:
        "Answer one of Pip's questions from the desk: one of its choices (from 0), words of your own, or both.",
      input: z
        .object({
          questionId: id,
          choice: z.number().int().min(0).max(9).optional(),
          text: z.string().trim().min(1).max(2000).optional(),
        })
        .refine((a) => a.choice !== undefined || a.text !== undefined, {
          message: "Pick one of its choices or write an answer.",
        }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        atTheDesk(ctx.caller);
        const answer = {
          ...(i.choice !== undefined ? { choice: i.choice } : {}),
          ...(i.text !== undefined ? { text: i.text } : {}),
        };
        const r = await answerQuestion(ctx, i.questionId, answer);
        if (!r.ok) throw new ActionError("conflict", r.reason);
        return { answered: true };
      },
    }),
    defineAction({
      name: "desk.reply",
      description:
        "Send one of the ready replies a finished-work card offers (from 0) as your message in its conversation, and clear the card.",
      input: z.strictObject({ id, choice: z.number().int().min(0).max(1) }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        atTheDesk(ctx.caller);
        const [card] = await ctx.tx
          .select({ dedupeKey: notification.dedupeKey })
          .from(notification)
          .where(and(eq(notification.id, i.id), eq(notification.kind, "finished"), live(ctx.now)));
        if (!card) throw new ActionError("not_found", "That card isn't on the desk.");
        // Only words Pip offered after the card's own turn, and only while they're fresh: once
        // you've written there, or Pip has started again, they'd answer something else.
        const ready = await cardReplies(ctx.tx, card.dedupeKey);
        const text = ready?.replies[i.choice];
        if (!ready || text === undefined) throw new ActionError("conflict", STALE);
        // Through chat.send, with its rules: kept as the desktop's (heard), so Pip's turn after it
        // runs as anything the desktop starts does (D42), and never in a Slack member's thread.
        await ctx.call("chat.send", { conversationId: ready.conversationId, text });
        await ctx.call("inbox.mark", { ids: [i.id], state: "done" });
        return { sent: true };
      },
    }),
    // Any of your conversations, read at the desk (D86): conversation.ts.
    deskConversation(atTheDesk),
  ],
});

export { type DeskCard, type DeskKind, type DeskList, opensAt } from "./cards.ts";
