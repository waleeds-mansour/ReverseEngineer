// Your conversations at the desk (D86): the desktop's notch chats with Pip in place of Hearth's
// window, so while Windows Hello has the desk open it may read any of the owner's conversations, as
// Nook's window does. Without the desk nothing changes: the token reads only the conversations the
// app started, through conversation.get (D42).
//
// desk.conversation gives either the recent conversations, a line each (its title, when it last
// moved, and whether Pip is on it), or one conversation's lines a page at a time: the newest 50,
// a page further back with `before`, or what came after a line with `after`, which the notch asks
// for each second while Pip works. A line is what Nook's window shows as one: your words, Pip's,
// and its notices; tool calls stay in Nook. A Slack member's conversation is refused as
// conversation.get refuses the app one it didn't start: its words are a member's (D62).
import { type LogRecord, MEMBER_CONVERSATION, readyReplies } from "@hearth/core";
import { conversation, conversationLog, type DbOrTx, entity, jarvisTurn } from "@hearth/db";
import { type Caller, defineAction, notFound, requireEntity } from "@hearth/kernel";
import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { deskLabel, ownTriggerName } from "../assistant/deskLite.ts";
import { id } from "../shared.ts";

/** The most lines in one page. */
export const PAGE = 50;
/** How many recent conversations the switcher lists. */
export const RECENT = 20;

/** What the notch shows as a line: the rest of the log is Pip's working, which stays in Nook. */
const LINE_KINDS = ["user_message", "assistant_message", "error", "notice"];
/** What decides the ready replies, as cardReplies reads them (replies.ts). */
const NEXT_KINDS = ["user_message", "turn_started", "next"];
/** Turns that answer something the owner asked: Pip is thinking, not working (deskLite.ts). */
const ASKED = new Set(["chat", "voice_command"]);

/** A turn of Pip's here that hasn't ended: queued to run, or running. */
const unfinished = sql`${jarvisTurn.status} IN ('queued', 'running')`;

/** A routine's run, as conversation.list leaves it out: no record, and only Pip's own turns. */
const routineRun = sql`(${conversation.subjectId} IS NULL AND (SELECT bool_and(${jarvisTurn.mode} = 'proactive') FROM ${jarvisTurn} WHERE ${jarvisTurn.conversationId} = ${entity.id}))`;

/** When it last moved: its log's last line, or when it was made or renamed. */
const lastMoved = sql<Date>`coalesce(${conversation.lastTurnAt}, ${entity.updatedAt})`;

export interface DeskConversationLine {
  id: string;
  title: string;
  /** When it last moved, as an ISO time. */
  at: string;
  /** Pip has a turn here that hasn't ended. */
  working: boolean;
  /** The desktop app started it, so it's also readable without the desk. */
  mine: boolean;
}

/** What Pip is doing in a conversation, as the dock says it of Pip (deskLite.ts's `pip`). */
export interface DeskPip {
  state: "idle" | "thinking" | "working";
  /** A few words of what about, never its prompt: "what you asked". */
  label: string | null;
}

async function recent(db: DbOrTx): Promise<DeskConversationLine[]> {
  const rows = await db
    .select({
      id: entity.id,
      title: entity.title,
      at: lastMoved,
      startedVia: conversation.startedVia,
      working: sql<boolean>`EXISTS (SELECT 1 FROM ${jarvisTurn} WHERE ${jarvisTurn.conversationId} = ${entity.id} AND ${unfinished})`,
    })
    .from(entity)
    .innerJoin(conversation, eq(conversation.entityId, entity.id))
    .where(
      and(
        isNull(entity.deletedAt),
        sql`${routineRun} IS NOT TRUE`,
        sql`${conversation.startedVia} IS DISTINCT FROM ${MEMBER_CONVERSATION}`,
      ),
    )
    .orderBy(desc(lastMoved))
    .limit(RECENT);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    at: new Date(r.at).toISOString(),
    working: r.working === true,
    mine: r.startedVia === "device",
  }));
}

/** Pip's oldest unfinished turn here, as the dock would say it. */
async function pipIn(db: DbOrTx, conversationId: string): Promise<DeskPip> {
  const [turn] = await db
    .select({ trigger: jarvisTurn.trigger, context: jarvisTurn.context })
    .from(jarvisTurn)
    .where(and(eq(jarvisTurn.conversationId, conversationId), unfinished))
    .orderBy(asc(jarvisTurn.queuedAt))
    .limit(1);
  if (!turn) return { state: "idle", label: null };
  // A trigger's name only when the owner alone wrote it (ownTriggerName): Pip can rename them.
  const own = turn.trigger === "trigger" ? await ownTriggerName(db, turn.context?.triggerId) : null;
  return {
    state: ASKED.has(turn.trigger) ? "thinking" : "working",
    label: deskLabel(turn, own),
  };
}

interface Page {
  id: string;
  before?: number | undefined;
  after?: number | undefined;
  limit: number;
}

async function lines(db: DbOrTx, i: Page) {
  const e = await requireEntity(db, i.id, "conversation");
  const [c] = await db.select().from(conversation).where(eq(conversation.entityId, i.id));
  // The same answer conversation.get gives the app for one it didn't start (D42, D62).
  if (c?.startedVia === MEMBER_CONVERSATION) throw notFound("Conversation");
  const forward = i.after !== undefined;
  // A line more than asked, to know whether there's more past the page.
  const rows = await db
    .select()
    .from(conversationLog)
    .where(
      and(
        eq(conversationLog.conversationId, i.id),
        inArray(conversationLog.kind, LINE_KINDS),
        i.before !== undefined ? lt(conversationLog.idx, i.before) : undefined,
        i.after !== undefined ? gt(conversationLog.idx, i.after) : undefined,
      ),
    )
    .orderBy(forward ? asc(conversationLog.idx) : desc(conversationLog.idx))
    .limit(i.limit + 1);
  const more = rows.length > i.limit;
  const page = rows.slice(0, i.limit);
  if (!forward) page.reverse();
  // From the newest entries that decide them, as only they can say the replies are stale (D85).
  const deciding = await db
    .select()
    .from(conversationLog)
    .where(and(eq(conversationLog.conversationId, i.id), inArray(conversationLog.kind, NEXT_KINDS)))
    .orderBy(desc(conversationLog.idx))
    .limit(20);
  return {
    conversation: {
      id: e.id,
      title: e.title,
      startedVia: c?.startedVia ?? null,
      // Once it has read outside content, Pip asks more here: the notch says why, as Nook does.
      taintedAt: c?.taintedAt ?? null,
      taintSource: c?.taintSource ?? null,
    },
    /** Oldest first. */
    log: page,
    /** More lines lie past this page: older ones, or with `after` newer ones. */
    more,
    pip: await pipIn(db, i.id),
    next: readyReplies(deciding satisfies LogRecord[]),
  };
}

/**
 * desk.conversation, refusing anyone but the desktop app with its desk open: `atTheDesk` is the
 * desk's own check (index.ts), passed in so there's only one.
 */
export const deskConversation = (atTheDesk: (caller: Caller) => void) =>
  defineAction({
    name: "desk.conversation",
    description:
      "At the desk: your recent conversations with Pip, or one conversation's lines, the newest 50, a page further back (before) or what came after a line (after), with what Pip is doing there and the replies it offers.",
    input: z
      .strictObject({
        /** The conversation to read; without it, the recent ones. */
        id: id.optional(),
        /** Lines older than this one's idx. */
        before: z.number().int().min(0).optional(),
        /** Lines newer than this one's idx, oldest first. */
        after: z.number().int().min(-1).optional(),
        limit: z.number().int().min(1).max(PAGE).default(PAGE),
      })
      .refine((i) => i.before === undefined || i.after === undefined, {
        message: "Page back or forward, not both.",
      })
      .refine((i) => i.id !== undefined || (i.before === undefined && i.after === undefined), {
        message: "Paging needs a conversation.",
      }),
    risk: "read",
    callers: ["owner"],
    // Your own reads leave no audit row (D56); the notch's would, every second while Pip works.
    // A refused look still does.
    auditWhen: () => false,
    async handler(i, ctx) {
      atTheDesk(ctx.caller);
      if (i.id === undefined) return { conversations: await recent(ctx.tx) };
      return lines(ctx.tx, { ...i, id: i.id });
    },
  });
