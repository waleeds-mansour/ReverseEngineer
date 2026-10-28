// The desk's cards (D84): what in the inbox waits for you at the desktop, a short line each. The
// overlay shows them small and answers them from the keyboard, so a card carries a title and one
// line, never a whole email, and says when its words are outside content's. A question's card
// (D85) carries its choices, from lane O5b's question table.
import { approval, type DbOrTx, notification, question } from "@hearth/db";
import { and, count, desc, eq, gt, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { live } from "../inbox/index.ts";
import { isOutside, preview, writtenOutside } from "../shared.ts";

/** What the desk shows: Pip's asks and questions, finished work, the brief and your day. */
export const DESK_KINDS = ["approval", "question", "finished", "brief", "wrap"] as const;
export type DeskKind = (typeof DESK_KINDS)[number];
export const isDeskKind = (kind: string): kind is DeskKind =>
  (DESK_KINDS as readonly string[]).includes(kind);

/** The most cards the desk is given at once. */
export const MAX_CARDS = 30;
export const TITLE_MAX = 120;
export const LINE_MAX = 200;

/**
 * Where a card opens in Hearth's window; the phone's and the desktop's notifications open the same
 * place. An approval opens on Today's Needs you, which says when a send reaches someone who isn't
 * in its conversation; the brief and the evening card open there too, each in full with the rest
 * of your day. Anything else opens the inbox.
 */
const OPENS: Record<string, string> = { approval: "/today", brief: "/today", wrap: "/today" };
export const opensAt = (kind: string): string => OPENS[kind] ?? "/inbox";

export interface DeskCard {
  /** The inbox item's id, which desk.mark takes. */
  id: string;
  kind: DeskKind;
  /** One line, at most 120 characters. */
  title: string;
  /** One line, at most 200 characters; empty when there's nothing more to say. */
  line: string;
  /** When it came, as an ISO time. */
  at: string;
  /** The page in Hearth's window it opens. */
  url: string;
  /** Some of its words are outside content's (an email's, a page's): show them as such. */
  outside: boolean;
  /** You've seen it, though it isn't done. */
  seen: boolean;
  /** An approval's: what desk.decide takes, how far it reaches, and when it runs out. */
  approvalId?: string;
  risk?: string;
  expiresAt?: string | null;
  /** A question's: what desk.answer takes, and the choices it numbers. */
  questionId?: string;
  choices?: string[];
}

export interface DeskList {
  cards: DeskCard[];
  /** How many of each kind are on the desk in all, not only the cards given. */
  counts: Record<DeskKind, number> & { total: number };
}

/**
 * On the desk: the inbox's live items of the desk's kinds. An approval's card only while it still
 * waits for a yes or no: one being done, decided or run out has nothing left to answer.
 */
const onDesk = (now: Date) =>
  and(
    live(now),
    inArray(notification.kind, [...DESK_KINDS]),
    or(
      isNull(notification.approvalId),
      and(
        eq(approval.status, "pending"),
        or(isNull(approval.expiresAt), gt(approval.expiresAt, now)),
      ),
    ),
  );

/** A question card's question (D85): its card's dedupe key names it, "question:<id>". */
export const cardQuestion: SQL = sql`${notification.dedupeKey} = 'question:' || ${question.id}::text`;

/** Still waiting for an answer, even before its sweep puts it away. */
export const openQuestion = (now: Date): SQL =>
  sql`(${question.status} = 'open' AND ${question.expiresAt} > ${now})`;

/**
 * What can't wait comes first, so no pile of finished work pushes it out of the 30: approvals
 * that wait for a yes or no, then Pip's open questions, then the rest; each newest first.
 */
const rank = (now: Date) =>
  sql`CASE WHEN ${notification.kind} = 'approval' THEN 0
    WHEN ${notification.kind} = 'question' AND ${openQuestion(now)} THEN 1 ELSE 2 END`;

/** The first line with anything on it. */
const firstLine = (text: string | null | undefined) =>
  (text ?? "").split("\n").find((l) => l.trim()) ?? "";

export async function deskCards(db: DbOrTx, now: Date, limit = MAX_CARDS): Promise<DeskList> {
  const rows = await db
    .select({
      n: notification,
      a: {
        status: approval.status,
        risk: approval.risk,
        expiresAt: approval.expiresAt,
        origin: approval.origin,
        requestedBy: approval.requestedBy,
        reason: approval.reason,
      },
      q: {
        id: question.id,
        choices: question.choices,
        origin: question.origin,
        open: sql<boolean>`${openQuestion(now)}`,
      },
    })
    .from(notification)
    .leftJoin(approval, eq(approval.id, notification.approvalId))
    .leftJoin(question, cardQuestion)
    .where(onDesk(now))
    .orderBy(rank(now), desc(notification.createdAt))
    .limit(Math.min(limit, MAX_CARDS));
  const tally = await db
    .select({ kind: notification.kind, n: count() })
    .from(notification)
    .leftJoin(approval, eq(approval.id, notification.approvalId))
    .where(onDesk(now))
    .groupBy(notification.kind);
  const counts = { approval: 0, question: 0, finished: 0, brief: 0, wrap: 0, total: 0 };
  for (const t of tally) {
    if (!isDeskKind(t.kind)) continue;
    counts[t.kind] = t.n;
    counts.total += t.n;
  }
  const cards = rows.map(({ n, a, q }): DeskCard => {
    const kind = n.kind as DeskKind;
    const card: DeskCard = {
      id: n.id,
      kind,
      title: preview(n.title, TITLE_MAX),
      line: preview(firstLine(n.body), LINE_MAX),
      at: n.createdAt.toISOString(),
      url: opensAt(kind),
      outside: isOutside(n),
      seen: n.state === "seen",
    };
    if (kind === "approval" && n.approvalId && a) {
      // Its title is the inbox's "Pip asks: …"; its line, what follows (an email's first line),
      // or why it asks. Asked after reading outside content, or by an outside agent, its words
      // may be outside content's even when the card's weren't marked.
      if (!card.line) card.line = preview(a.reason, LINE_MAX);
      card.outside ||= a.origin === "untrusted" || writtenOutside(a.requestedBy ?? "");
      card.approvalId = n.approvalId;
      card.risk = a.risk ?? undefined;
      card.expiresAt = a.expiresAt?.toISOString() ?? null;
    }
    // An answered or lapsed question has nothing left to pick.
    if (kind === "question" && q?.id && q.open) {
      card.questionId = q.id;
      card.choices = (q.choices ?? []).map((c) => preview(c, LINE_MAX));
      // Asked by a turn that had read outside content (D58).
      card.outside ||= q.origin === "untrusted";
    }
    return card;
  });
  return { cards, counts };
}
