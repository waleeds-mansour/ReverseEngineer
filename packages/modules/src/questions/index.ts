// Pip asks with choices, and says when it finished something (D85). When a decision is the owner's
// and has two or three clear options, Pip asks with ask_owner: the question waits in the inbox
// with numbered choices, its turn ends there, and answering starts it again in the same
// conversation, in the same job, as trusted as it was. It never stands in for an approval: what
// needs a yes still asks for one. Finished-work cards are in finished.ts.
import { asUntrusted } from "@hearth/core";
import { jarvisTurn, question } from "@hearth/db";
import {
  ActionError,
  createNotification,
  defineAction,
  defineModule,
  newId,
  type ReflexDef,
  type ReflexOutcome,
  upsertSchedule,
} from "@hearth/kernel";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { id } from "../shared.ts";
import {
  answerQuestion,
  expireQuestion,
  MAX_ANSWER,
  QUESTION_ANSWERED,
  QUESTION_ASKED,
  QUESTION_TTL_MS,
  type QuestionRow,
  questionKey,
} from "./answer.ts";
import { FINISHED_CARD, finishedWork, recordFinished, TURN_FINISHED } from "./finished.ts";

export {
  type AnswerContext,
  type AnswerResult,
  answerQuestion,
  listOpenQuestions,
  QUESTION_ANSWERED,
  type QuestionRow,
} from "./answer.ts";
export { finishedCard, firstLine } from "./finished.ts";

const EXPIRE = "questions.expire";

/** What the model hears once it has asked: it stops there, and is started again with the answer. */
const WAITING =
  "The owner has your question, with its choices, in their inbox. Stop here: end your turn with one short sentence saying what you asked, and do nothing that depends on the answer. You'll be started again in this conversation once they answer.";
const ASKED_ALREADY =
  "You already asked the owner something this turn. Stop here and wait for their answer.";
/** At most this many questions wait at once, and fewer from turns that read outside content: a
 * page or an email can't fill the owner's inbox with them. */
const MAX_OPEN = 8;
const MAX_OPEN_OUTSIDE = 3;
const TOO_MANY =
  "The owner already has several of your questions waiting. Don't add another: ask this in your reply instead.";

/** The choices as the card's body: "1. Friday · 2. Monday". */
const numbered = (choices: string[]) => choices.map((c, i) => `${i + 1}. ${c}`).join(" · ");

/**
 * The owner's answer, in words for the turn that picks the work up again. Words a device sent
 * outside the desk are quoted as outside content (answerQuestion).
 */
function said(q: QuestionRow, quote: (s: string) => string, outside: boolean): string {
  const a = q.answer ?? {};
  const picked = a.choice !== undefined ? q.choices[a.choice] : undefined;
  const words = outside ? asUntrusted(a.text ?? "", "answer") : (a.text ?? "");
  if (picked !== undefined && a.text)
    return `they chose ${quote(picked)} and added, in their own words: ${words}`;
  if (picked !== undefined) return `they chose ${quote(picked)}`;
  return `they answered, in their own words: ${words}`;
}

/**
 * The turn that picks the work up again, in the asking turn's conversation, lane and job, and as
 * trusted as the question was. question.answered carries that trust, or less when a device that
 * isn't the desk answered (answerQuestion), and the turn is no more trusted than its event.
 */
function resumeTurn(
  q: QuestionRow,
  turn: { lane: "fast" | "deep"; mode: string; subjectId: string | null; roleId: string | null },
  answerOutside: boolean,
): ReflexOutcome {
  // Pip's own words, but from a turn that read outside content: quoted as such (D58).
  const outside = q.origin === "untrusted";
  const quote = (s: string) => (outside ? asUntrusted(s, "ask_owner") : `"${s}"`);
  return {
    kind: "turn",
    trigger: "approval",
    lane: turn.lane,
    conversationId: q.conversationId,
    subjectId: turn.subjectId,
    dedupeKey: questionKey(q.id),
    origin: q.origin,
    // Background work stays background work: answering doesn't make it yours.
    ...(turn.mode === "proactive" ? { proactive: true } : {}),
    ...(turn.roleId ? { roleId: turn.roleId } : {}),
    context: { resumes: q.turnId, question: q.id },
    prompt: `You asked the owner ${quote(q.question)} (question ${q.id}), and ${said(q, quote, answerOutside)}.\nCarry on with the work from there. If nothing is left, reply briefly or not at all.`,
    fallback: [
      {
        kind: "note",
        observation: {
          kind: "followup",
          text: "The owner answered one of Pip's questions, but Pip couldn't pick the work back up (paused, or out of turns for today).",
          aboutId: q.conversationId,
        },
      },
    ],
  };
}

const resume: ReflexDef = {
  name: "questions.resume_jarvis",
  description: "After you answer one of Pip's questions, it picks up where it left off.",
  mode: "reactive",
  on: [QUESTION_ANSWERED],
  async run(e, ctx) {
    const qid = String(e.payload.questionId ?? "");
    const [row] = await ctx.db
      .select({
        q: question,
        lane: jarvisTurn.lane,
        mode: jarvisTurn.mode,
        subjectId: jarvisTurn.subjectId,
        roleId: jarvisTurn.roleId,
      })
      .from(question)
      .leftJoin(jarvisTurn, eq(jarvisTurn.id, question.turnId))
      .where(eq(question.id, qid));
    if (row?.q.status !== "answered") return [];
    const turn = {
      lane: row.lane ?? "fast",
      mode: row.mode ?? "reactive",
      subjectId: row.subjectId ?? null,
      roleId: row.roleId ?? null,
    };
    return [resumeTurn(row.q, turn, e.payload.outside === true)];
  },
};

/** A question nobody answered lapses: its card goes, and Pip stops waiting. */
const expire: ReflexDef = {
  name: EXPIRE,
  description: "A question of Pip's that nobody answered for three days is put away.",
  mode: "always",
  on: [],
  run: () => [],
  async onCheck(payload) {
    return [{ kind: "act", action: "question.expire", input: { id: payload.questionId } }];
  },
};

export const questionsModule = defineModule({
  name: "questions",
  description:
    "Pip's questions with numbered choices for you to pick from, and cards for work it finished on its own.",
  entityTypes: [],
  events: [
    {
      kind: QUESTION_ASKED,
      description:
        "Pip asked the owner a question with choices. Payload: questionId, conversationId, turnId.",
    },
    {
      kind: QUESTION_ANSWERED,
      description:
        "The owner answered one of Pip's questions. Payload: questionId, conversationId; outside when a device other than the desk sent the answer, desk when the desk did.",
    },
    {
      kind: TURN_FINISHED,
      description:
        "Pip finished a turn. Payload: turnId, trigger, status, outcome, conversationId.",
    },
  ],
  kernelEvents: ["notification.created", "notification.updated"],
  knowledge: {},
  actions: [
    defineAction({
      name: "ask.owner",
      // Asking stays within any job's ceiling, as telling does (Spec 3).
      reports: true,
      description:
        "Ask the owner to decide something that is theirs to decide, with 2 or 3 short choices to pick from. They answer from their inbox and you're started again here with the answer, so end your turn right after. Never instead of an approval: what needs their yes still waits for one.",
      input: z.object({
        question: z
          .string()
          .trim()
          .min(3)
          .max(120)
          .describe("A short sentence, in your own words."),
        choices: z
          .array(z.string().trim().min(1).max(60))
          .min(2)
          .max(3)
          .describe('Short answers the owner can pick, like "Friday" or "Skip it".'),
        why: z.string().trim().max(200).optional().describe("Why you ask, in one sentence."),
        recommended: z
          .number()
          .int()
          .min(0)
          .max(2)
          .optional()
          .describe(
            "The choice you'd pick, by its place in choices (from 0), only when one is clearly better; say why in why.",
          ),
      }),
      risk: "internal",
      callers: ["agent"],
      async handler(i, ctx) {
        const { turnId, conversationId } = ctx.caller;
        if (!turnId || !conversationId)
          throw new ActionError("invalid_input", "Only one of Pip's turns can ask the owner.");
        if (new Set(i.choices.map((c) => c.toLowerCase())).size !== i.choices.length)
          throw new ActionError("invalid_input", "Give choices that differ from each other.");
        // A recommendation names one of these choices, or the Inbox would mark nothing (or the
        // wrong thing) as Recommended.
        if (i.recommended !== undefined && i.recommended >= i.choices.length)
          throw new ActionError(
            "invalid_input",
            `Recommend one of your ${i.choices.length} choices by its place, from 0 to ${i.choices.length - 1}.`,
          );
        // Questions are asked one at a time, so the limits below hold with two turns asking.
        await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hearth_questions'))`);
        const [asked] = await ctx.tx
          .select({ id: question.id })
          .from(question)
          .where(and(eq(question.turnId, turnId), eq(question.status, "open")));
        if (asked) return { questionId: asked.id, waiting: ASKED_ALREADY };
        const { origin } = ctx.caller;
        const [open] = await ctx.tx
          .select({
            all: count(),
            outside: sql<number>`count(*) FILTER (WHERE ${question.origin} = 'untrusted')`.mapWith(
              Number,
            ),
          })
          .from(question)
          .where(and(eq(question.status, "open"), gt(question.expiresAt, ctx.now)));
        const outside = origin === "untrusted" ? (open?.outside ?? 0) : 0;
        if ((open?.all ?? 0) >= MAX_OPEN || outside >= MAX_OPEN_OUTSIDE)
          throw new ActionError("conflict", TOO_MANY);
        const qid = newId();
        const expiresAt = new Date(ctx.now.getTime() + QUESTION_TTL_MS);
        await ctx.tx.insert(question).values({
          id: qid,
          conversationId,
          turnId,
          question: i.question,
          choices: i.choices,
          why: i.why || null,
          recommended: i.recommended ?? null,
          origin,
          createdAt: ctx.now,
          expiresAt,
        });
        await createNotification(ctx, {
          kind: "question",
          title: i.question,
          // The choices first, as the desk shows only a line; why Pip asks, under them.
          body: i.why ? `${numbered(i.choices)}\n${i.why}` : numbered(i.choices),
          entityId: conversationId,
          urgency: "normal",
          dedupeKey: questionKey(qid),
          // Asked after reading outside content, it may have been steered: the card says so.
          ...(origin === "untrusted" ? { outside: true } : {}),
        });
        await upsertSchedule(
          ctx.tx,
          {
            id: `check:${EXPIRE}:${qid}`,
            kind: "check",
            runAt: expiresAt,
            payload: { reflex: EXPIRE, questionId: qid },
          },
          ctx.now,
        );
        ctx.emit({
          kind: QUESTION_ASKED,
          entityId: conversationId,
          payload: { questionId: qid, conversationId, turnId },
        });
        return { questionId: qid, waiting: WAITING };
      },
    }),
    defineAction({
      name: "question.answer",
      description:
        "Answer one of Pip's questions: a choice by its place in the list (from 0), your own words, or both. Pip picks the work up again.",
      input: z.object({
        id,
        choice: z.number().int().min(0).max(2).optional(),
        text: z.string().max(MAX_ANSWER).optional(),
      }),
      risk: "internal",
      callers: ["owner"],
      async handler(i, ctx) {
        const r = await answerQuestion(ctx, i.id, {
          ...(i.choice !== undefined ? { choice: i.choice } : {}),
          ...(i.text !== undefined ? { text: i.text } : {}),
        });
        // Refused, as desk.answer refuses it: answered already, lapsed, or no such choice.
        if (!r.ok) throw new ActionError("conflict", r.reason);
        return r;
      },
    }),
    defineAction({
      name: "question.expire",
      description: "Put away a question of Pip's that nobody answered in time.",
      input: z.object({ id }),
      risk: "internal",
      callers: ["system"],
      async handler(i, ctx) {
        const [q] = await ctx.tx
          .select({ expiresAt: question.expiresAt })
          .from(question)
          .where(eq(question.id, i.id));
        // Moved on since (answered), or not due yet: nothing to do.
        if (!q || q.expiresAt > ctx.now) return { expired: false };
        return { expired: await expireQuestion(ctx, i.id) };
      },
    }),
    defineAction({
      name: FINISHED_CARD,
      description:
        "Put a quiet card in the inbox for work Pip finished on its own, or add it to the card for the same routine or job while that's unseen.",
      input: z.object({ turnId: id }),
      risk: "internal",
      callers: ["system"],
      async handler(i, ctx) {
        return (await recordFinished(ctx, i.turnId)) ?? { id: null, gathered: 0 };
      },
    }),
  ],
  reflexes: [resume, expire, finishedWork],
});
