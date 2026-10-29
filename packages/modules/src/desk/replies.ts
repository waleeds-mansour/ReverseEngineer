// Ready replies on a finished-work card (D85): the replies Pip offered after the very turn the
// card is about, while they're still fresh. The desk shows them under the card and sends the one
// you pick with desk.reply, as your own message in that turn's conversation.
//
// Only that turn's: a card says "Pip finished its heartbeat", so replies from a later chat in the
// same conversation would answer something the card doesn't show. A card that gathers several
// turns names the latest in its key, so it offers the latest one's. Under today's rules the two
// rarely meet: a finished card is for a conversation you aren't in, and replies are offered in
// the ones you are (packages/jarvis/src/next.ts). The desk shows them whenever they do.
import { isUuid, type LogRecord, readyReplies } from "@hearth/core";
import { conversationLog, type DbOrTx, jarvisTurn } from "@hearth/db";
import { and, desc, eq, inArray } from "drizzle-orm";

export interface CardReplies {
  /** The turn's conversation, where a reply is sent. */
  conversationId: string;
  /** One or two, as the desk numbers them from 0. */
  replies: string[];
  /** Written after reading outside content (D58): still only offered, and marked. */
  outside: boolean;
}

/** The turn a finished card is about: its key ends with it, "finished:<group>:<turnId>". */
export function cardTurn(dedupeKey: string | null | undefined): string | null {
  if (!dedupeKey?.startsWith("finished:")) return null;
  const turnId = dedupeKey.slice(dedupeKey.lastIndexOf(":") + 1);
  return isUuid(turnId) ? turnId : null;
}

/** The fresh replies a finished card offers, or null when it offers none. */
export async function cardReplies(
  db: DbOrTx,
  dedupeKey: string | null | undefined,
): Promise<CardReplies | null> {
  const turnId = cardTurn(dedupeKey);
  if (!turnId) return null;
  // The newest entries that decide it in the turn's conversation, as readyRepliesFor reads them.
  const rows = await db
    .select({ r: conversationLog })
    .from(conversationLog)
    .innerJoin(jarvisTurn, eq(jarvisTurn.conversationId, conversationLog.conversationId))
    .where(
      and(
        eq(jarvisTurn.id, turnId),
        inArray(conversationLog.kind, ["user_message", "turn_started", "next"]),
      ),
    )
    .orderBy(desc(conversationLog.idx))
    .limit(20);
  const log = rows.map((x) => x.r) satisfies LogRecord[];
  const ready = readyReplies(log);
  // The newest `next` entry is the one readyReplies offers, unless something since made it stale.
  const latest = log.find((r) => r.kind === "next");
  if (ready.replies.length === 0 || latest?.turnId !== turnId) return null;
  return { conversationId: latest.conversationId, ...ready };
}
