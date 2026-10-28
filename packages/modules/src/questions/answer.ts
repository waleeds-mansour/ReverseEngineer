// Answering one of Pip's questions (D85), from wherever the owner answers it: the inbox, the
// desktop's desk. A single answer each, and none once it has lapsed. Answering closes its card, and
// question.answered starts Pip again where it asked (questions.resume_jarvis).
import { isUuid } from "@hearth/core";
import { type DbOrTx, notification, type QuestionAnswer, question } from "@hearth/db";
import { type ActionContext, appendEvents, type Caller } from "@hearth/kernel";
import { and, asc, eq, ne } from "drizzle-orm";

/** What answering needs of an action's context: its transaction, time, caller and events. */
export type AnswerContext = Pick<ActionContext, "tx" | "now" | "caller" | "emit" | "correlationId">;

export type AnswerResult = { ok: true } | { ok: false; reason: string };

export type QuestionRow = typeof question.$inferSelect;

export const QUESTION_ASKED = "question.asked";
export const QUESTION_ANSWERED = "question.answered";
/** How long a question waits for an answer before Pip stops waiting. */
export const QUESTION_TTL_MS = 3 * 24 * 60 * 60_000;
/** The longest answer in the owner's own words. */
export const MAX_ANSWER = 2000;

/** The question's inbox card, and the turn that picks the work up again, by this key. */
export const questionKey = (id: string) => `question:${id}`;

/**
 * Whether an answer is the owner's own: given in Nook, or at the desktop's desk, which Windows
 * Hello opened (D84). Anything else a device sends could have been typed by whatever runs on it,
 * so it stays outside content (D58).
 */
export const ownAnswer = (c: Pick<Caller, "kind" | "origin" | "desk">) =>
  (c.kind === "owner" && c.origin === "owner") || c.desk === true;

/** Puts the question's card away, once it's answered or has lapsed. */
export async function closeCard(ctx: AnswerContext, id: string): Promise<void> {
  const rows = await ctx.tx
    .update(notification)
    .set({ state: "done", updatedAt: ctx.now })
    .where(and(eq(notification.dedupeKey, questionKey(id)), ne(notification.state, "done")))
    .returning({ id: notification.id, entityId: notification.entityId });
  for (const r of rows)
    ctx.emit({
      kind: "notification.updated",
      entityId: r.entityId,
      payload: { notificationId: r.id, state: "done" },
    });
}

/** Marks an open question lapsed and puts its card away. False when it wasn't open. */
export async function expireQuestion(ctx: AnswerContext, id: string): Promise<boolean> {
  const [row] = await ctx.tx
    .update(question)
    .set({ status: "expired" })
    .where(and(eq(question.id, id), eq(question.status, "open")))
    .returning({ id: question.id });
  if (!row) return false;
  await closeCard(ctx, id);
  return true;
}

/**
 * Answers a question: `choice` is a choice's place in its list, from 0 (the desk's key 1 is 0),
 * `text` the owner's own words; either or both. Records the answer, puts the card away and lets
 * Pip pick the work up again: as trusted as the question was when it's the owner's own answer
 * (ownAnswer), as outside content when another device sent it. A second answer, or one after it
 * lapsed, is refused with a reason to show as it is, as is an answer that names no choice it has.
 */
export async function answerQuestion(
  ctx: AnswerContext,
  questionId: string,
  answer: { choice?: number; text?: string },
): Promise<AnswerResult> {
  const text = answer.text?.trim() || undefined;
  const { choice } = answer;
  if (choice === undefined && !text)
    return { ok: false, reason: "Pick one of the choices, or write an answer." };
  if (text && text.length > MAX_ANSWER)
    return { ok: false, reason: `Keep the answer under ${MAX_ANSWER} characters.` };
  if (!isUuid(questionId)) return { ok: false, reason: "Pip has no such question." };
  // Locked, so two answers at once can't both go through.
  const [q] = await ctx.tx.select().from(question).where(eq(question.id, questionId)).for("update");
  if (!q) return { ok: false, reason: "Pip has no such question." };
  if (q.status === "answered") return { ok: false, reason: "That question was already answered." };
  // Past its time it's refused, though its sweep (questions.expire) may not have put it away yet:
  // a refusal rolls back, so the sweep is what does.
  if (q.status === "expired" || q.expiresAt <= ctx.now)
    return { ok: false, reason: "That question lapsed, so Pip stopped waiting for an answer." };
  if (
    choice !== undefined &&
    !(Number.isInteger(choice) && choice >= 0 && choice < q.choices.length)
  )
    return { ok: false, reason: `Pick a choice from 1 to ${q.choices.length}.` };
  const value: QuestionAnswer = {
    ...(choice !== undefined ? { choice } : {}),
    ...(text ? { text } : {}),
  };
  await ctx.tx
    .update(question)
    .set({ status: "answered", answer: value, answeredAt: ctx.now })
    .where(eq(question.id, q.id));
  await closeCard(ctx, q.id);
  // The owner's own answer picks the work up as trusted as the question was, like a decided
  // approval (resolvedOrigin); a device's answer, no more than outside content, words and all.
  const own = ownAnswer(ctx.caller);
  await appendEvents(
    ctx.tx,
    [
      {
        kind: QUESTION_ANSWERED,
        entityId: q.conversationId,
        payload: {
          questionId: q.id,
          conversationId: q.conversationId,
          ...(own ? {} : { outside: true }),
          ...(ctx.caller.desk ? { desk: true } : {}),
        },
      },
    ],
    {
      actor: ctx.caller.principal,
      origin: own ? q.origin : "untrusted",
      correlationId: ctx.correlationId,
      causationId: ctx.caller.causationId ?? null,
      at: ctx.now,
    },
  );
  return { ok: true };
}

/**
 * Questions still waiting for the owner, oldest first. With `now`, one past its time is left out
 * though its sweep hasn't run yet (questions.expire).
 */
export async function listOpenQuestions(tx: DbOrTx, now?: Date): Promise<QuestionRow[]> {
  const rows = await tx
    .select()
    .from(question)
    .where(eq(question.status, "open"))
    .orderBy(asc(question.createdAt))
    .limit(100);
  return now ? rows.filter((q) => q.expiresAt > now) : rows;
}
