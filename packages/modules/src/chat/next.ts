// Ready replies (D85): after Pip answers in a conversation you're in, up to two short replies you
// might send next ("Send it", "Make it shorter") are kept in its log as a `next` entry. They go
// stale once you write or another turn starts there (readyReplies, in @hearth/core), and they're
// only ever offered: nothing sends one but you.
import { type LogRecord, MEMBER_CONVERSATION, type ReadyReplies, readyReplies } from "@hearth/core";
import { conversation, conversationLog, type DbOrTx, type Tx } from "@hearth/db";
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { appendLog } from "./log.ts";

/** A line you wrote yourself, here: not a turn's own prompt, nor a Slack member's (D62). */
const yours = and(
  eq(conversationLog.kind, "user_message"),
  isNull(conversationLog.turnId),
  sql`coalesce(${conversationLog.payload}->>'by', '') NOT LIKE 'member:%'`,
);

/**
 * What you last wrote in a conversation, or null when you never wrote there: a routine's or a
 * watch's conversation is Pip's own, and a Slack member's is theirs. Ready replies are for the
 * ones you're in; a finished-work card is for the rest, since you'd see an answer in yours.
 */
export async function lastOwnerMessage(db: DbOrTx, conversationId: string): Promise<string | null> {
  const [c] = await db
    .select({ startedVia: conversation.startedVia })
    .from(conversation)
    .where(eq(conversation.entityId, conversationId));
  if (!c || c.startedVia === MEMBER_CONVERSATION) return null;
  const [row] = await db
    .select({ payload: conversationLog.payload })
    .from(conversationLog)
    .where(and(eq(conversationLog.conversationId, conversationId), yours))
    .orderBy(desc(conversationLog.idx))
    .limit(1);
  return row ? String(row.payload.text ?? "") : null;
}

/**
 * Keeps a turn's ready replies, unless they'd be stale already: you wrote since the turn started
 * (while it ran, too: its answer didn't see that), or another turn started there (the suggestion
 * runs after the answer, so either can happen first). Returns the entry's index, or null when it
 * was left out. Locks the conversation.
 */
export async function appendNext(
  tx: Tx,
  conversationId: string,
  turnId: string,
  replies: string[],
  now: Date,
  outside = false,
): Promise<number | null> {
  if (replies.length === 0) return null;
  await tx
    .select({ id: conversation.entityId })
    .from(conversation)
    .where(eq(conversation.entityId, conversationId))
    .for("update");
  const marks = await tx
    .select({ idx: conversationLog.idx, kind: conversationLog.kind })
    .from(conversationLog)
    .where(
      and(
        eq(conversationLog.conversationId, conversationId),
        eq(conversationLog.turnId, turnId),
        inArray(conversationLog.kind, ["turn_started", "turn_finished"]),
      ),
    )
    .orderBy(desc(conversationLog.idx));
  const started = marks.find((m) => m.kind === "turn_started");
  if (!started || !marks.some((m) => m.kind === "turn_finished")) return null;
  const [since] = await tx
    .select({ idx: conversationLog.idx })
    .from(conversationLog)
    .where(
      and(
        eq(conversationLog.conversationId, conversationId),
        gt(conversationLog.idx, started.idx),
        or(
          yours,
          and(eq(conversationLog.kind, "turn_started"), ne(conversationLog.turnId, turnId)),
        ),
      ),
    )
    .limit(1);
  if (since) return null;
  const [idx] = await appendLog(
    tx,
    conversationId,
    // Written after reading outside content, the words may have been steered: they're still only
    // offered, so the entry just says so (D58).
    [{ kind: "next", payload: { replies, ...(outside ? { outside } : {}) }, turnId }],
    now,
  );
  return idx ?? null;
}

/** The ready replies a conversation shows now: none once they're stale (see readyReplies). */
export async function readyRepliesFor(db: DbOrTx, conversationId: string): Promise<ReadyReplies> {
  // The newest entries that decide it: whatever is older is either stale or replaced.
  const rows = await db
    .select()
    .from(conversationLog)
    .where(
      and(
        eq(conversationLog.conversationId, conversationId),
        inArray(conversationLog.kind, ["user_message", "turn_started", "next"]),
      ),
    )
    .orderBy(desc(conversationLog.idx))
    .limit(20);
  return readyReplies(rows satisfies LogRecord[]);
}
