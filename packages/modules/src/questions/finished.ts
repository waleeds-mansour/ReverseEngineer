// Finished-work cards (D85): when a turn Pip ran on its own (a routine, the heartbeat, a reflex, a
// watch, one of your triggers, or work picked up again after you answered) finishes having done
// something for you, a quiet card says what it was about and the first line of what it said.
// While that card is still unseen, more finished work from the same routine or job joins it ("Pip
// finished 3 things: its heartbeat", with the latest line) rather than piling up beside it; once
// you've seen it, the next starts a card of its own.
import { type DbOrTx, event, jarvisTurn, notification } from "@hearth/db";
import {
  type ActionContext,
  createNotification,
  type NewNotification,
  type ReflexDef,
} from "@hearth/kernel";
import { and, desc, eq, sql } from "drizzle-orm";
import { deskLabel, ownTriggerName } from "../assistant/deskLite.ts";
import { lastOwnerMessage } from "../chat/next.ts";

export const TURN_FINISHED = "jarvis.turn_finished";
/** The system's action that puts a finished turn's card in the inbox. */
export const FINISHED_CARD = "finished.card";

/**
 * Turns the owner starts, whose answers they see where they asked: a chat (the desktop's quick-ask
 * too), a voice command, an @mention, a task's thread, and a Slack member's.
 */
const STARTED_BY_YOU = new Set(["chat", "voice_command", "mention", "assignment", "slack_member"]);
/** Routines that only keep Pip's own notes up to date: what it remembers, lines about people. */
const UPKEEP = new Set(["memory", "personas"]);

const TITLE_MAX = 120;
const BODY_MAX = 200;
/** A card that gathers several: "Pip finished 3 things: …". */
const GATHERED = /^Pip finished (\d+) things: /;

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

type TurnRow = typeof jarvisTurn.$inferSelect;

/** The first line of a reply, as a card's body: no heading marks, bullets or bold. */
export function firstLine(reply: string | null): string | null {
  const line = (reply ?? "")
    .split("\n")
    .map((l) =>
      l
        .replace(/^\s*(#{1,6}\s+|[-*•>]\s+|\d+[.)]\s+)/, "")
        .replaceAll("**", "")
        .trim(),
    )
    .find((l) => l.length > 0);
  return line ? clip(line, BODY_MAX) : null;
}

/** Whether a turn already put a card in the inbox (a brief, a question, a note it told you). */
async function toldAlready(db: DbOrTx, turnId: string): Promise<boolean> {
  const rows = await db
    .select({ seq: event.seq })
    .from(event)
    .where(and(eq(event.correlationId, turnId), eq(event.kind, "notification.created")))
    .limit(1);
  return rows.length > 0;
}

/**
 * The routine, reflex or trigger a turn came from, whose unseen card its own joins: work picked
 * up again after your answers is one more.
 */
function groupOf(turn: TurnRow): string {
  const c = turn.context;
  if (c.question) return "decided";
  const key = turn.trigger === "trigger" ? c.triggerId : (c.source ?? c.routine);
  const k = typeof key === "string" ? key.replace(/[^\w.-]/g, "-") : "";
  return k ? `${turn.trigger}/${k}` : turn.trigger;
}

export interface Finished {
  /** Its group's unseen card gathers it (groupOf). */
  group: string;
  /** What it was about: "its heartbeat". */
  label: string;
  card: NewNotification;
}

/**
 * The card for a finished turn, or null when it gets none. "Did something" is the turn's own
 * outcome (classifyOutcome in packages/jarvis): it changed records, or acted or sent through its
 * tools. Reading, noting for the brief, telling you, and waiting on your yes or your answer
 * aren't.
 */
export async function finishedCard(db: DbOrTx, turnId: string): Promise<Finished | null> {
  const [turn] = await db.select().from(jarvisTurn).where(eq(jarvisTurn.id, turnId));
  if (turn?.status !== "done" || turn.outcome !== "act" || STARTED_BY_YOU.has(turn.trigger))
    return null;
  if (turn.trigger === "routine" && UPKEEP.has(String(turn.context.routine ?? ""))) return null;
  // In a conversation you're in (work picked up again there), you see its answer already.
  if (turn.conversationId && (await lastOwnerMessage(db, turn.conversationId)) !== null)
    return null;
  if (await toldAlready(db, turn.id)) return null;
  const own = turn.trigger === "trigger" ? await ownTriggerName(db, turn.context.triggerId) : null;
  // Work picked up again after you answered one of its questions: you decided, not approved.
  const label = turn.context.question ? "what you decided" : deskLabel(turn, own);
  const body = firstLine(turn.reply);
  const entityId = turn.subjectId ?? turn.conversationId;
  const group = groupOf(turn);
  return {
    group,
    label,
    card: {
      kind: "finished",
      title: clip(`Pip finished ${label}`, TITLE_MAX),
      ...(body ? { body } : {}),
      ...(entityId ? { entityId } : {}),
      urgency: "quiet",
      dedupeKey: `finished:${group}:${turn.id}`,
      // What it read may have steered what it said: the card says so (D58).
      outside: turn.origin === "untrusted" || turn.context.readOutside === true,
    },
  };
}

type CardContext = Pick<ActionContext, "tx" | "now" | "caller" | "emit">;

/**
 * Puts a finished turn's card in the inbox, or folds it into its group's card while you haven't
 * seen that yet. The card's key names the latest turn in it, so the same turn never counts twice.
 */
export async function recordFinished(
  ctx: CardContext,
  turnId: string,
): Promise<{ id: string; gathered: number } | null> {
  const f = await finishedCard(ctx.tx, turnId);
  if (!f) return null;
  const prefix = `finished:${f.group}:`;
  // A group's turns are carded one at a time, so two can't both start a card.
  await ctx.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`);
  const [open] = await ctx.tx
    .select()
    .from(notification)
    .where(
      and(
        eq(notification.kind, "finished"),
        eq(notification.state, "unseen"),
        sql`starts_with(${notification.dedupeKey}, ${prefix})`,
      ),
    )
    .orderBy(desc(notification.createdAt))
    .limit(1);
  if (!open) {
    const created = await createNotification(ctx, f.card);
    return created ? { id: created.id, gathered: 1 } : null;
  }
  if (open.dedupeKey === f.card.dedupeKey) return null;
  const gathered = Number(GATHERED.exec(open.title)?.[1] ?? 1) + 1;
  // Its words are the latest turn's, or still an earlier one's when the latest said nothing.
  const body = f.card.body ?? open.body;
  const outside =
    f.card.outside === true || ctx.caller.origin === "untrusted" || (!f.card.body && open.outside);
  const title = clip(`Pip finished ${gathered} things: ${f.label}`, TITLE_MAX);
  await ctx.tx
    .update(notification)
    .set({
      title,
      body,
      outside,
      entityId: f.card.entityId ?? open.entityId,
      dedupeKey: f.card.dedupeKey ?? null,
      updatedAt: ctx.now,
    })
    .where(eq(notification.id, open.id));
  ctx.emit({
    kind: "notification.updated",
    entityId: f.card.entityId ?? open.entityId,
    payload: { notificationId: open.id, kind: "finished", title, ...(outside ? { outside } : {}) },
  });
  return { id: open.id, gathered };
}

export const finishedWork: ReflexDef = {
  name: "questions.finished_work",
  description: "When Pip finishes something it did on its own, a quiet card says what it did.",
  mode: "always",
  on: [TURN_FINISHED],
  // Pip's own event: this only writes a card, so it can't set Pip going again.
  includeJarvisEvents: true,
  run(e) {
    const p = e.payload;
    if (p.status !== "done" || p.outcome !== "act" || typeof p.turnId !== "string") return [];
    return [{ kind: "act", action: FINISHED_CARD, input: { turnId: p.turnId } }];
  },
};
