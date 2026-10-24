// Your Slack talk with someone, both sides: your DM with them, group DMs you both wrote in, the
// threads you both wrote in, and @mentions either way. What Pip writes a person's persona from
// (people/persona.ts). Their words are outside content (D58).
import {
  type DbOrTx,
  entity,
  slackChannel,
  slackMessage,
  slackUser,
  slackWorkspace,
} from "@hearth/db";
import {
  and,
  arrayOverlaps,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { named } from "./save.ts";

const other = alias(slackMessage, "other");

/** Their Slack users and yours: who "you" and "they" are in Slack. */
export interface Talkers {
  me: string;
  them: string[];
}

/** One of the messages, as Pip reads them. */
export interface TalkLine {
  at: Date;
  /** Yours, not theirs. */
  mine: boolean;
  /** "a direct message", "a group message", "#design". */
  where: string;
  text: string;
}

/** The Slack users a person is, and you in that workspace; null when there's none. */
export async function talkersFor(db: DbOrTx, personId: string): Promise<Talkers | null> {
  const [ws] = await db.select({ me: slackWorkspace.userId }).from(slackWorkspace).limit(1);
  if (!ws) return null;
  const them = await db
    .select({ id: slackUser.id })
    .from(slackUser)
    .where(eq(slackUser.personId, personId));
  return them.length ? { me: ws.me, them: them.map((u) => u.id) } : null;
}

/** Messages in this place (or, in a channel, this thread) that `who` wrote. */
function wroteHere(db: DbOrTx, who: SQL, thread: boolean) {
  const start = sql`coalesce(${slackMessage.threadTs}, ${slackMessage.ts})`;
  return exists(
    db
      .select({ one: sql`1` })
      .from(other)
      .where(
        and(
          eq(other.channelId, slackMessage.channelId),
          who,
          thread ? or(eq(other.ts, start), eq(other.threadTs, start)) : undefined,
        ),
      ),
  );
}

/** A message that's part of your talk with them. */
function shared(db: DbOrTx, t: Talkers) {
  const theirs = inArray(slackMessage.userId, t.them);
  const yours = eq(slackMessage.userId, t.me);
  return and(
    or(theirs, yours),
    or(
      and(eq(slackChannel.kind, "dm"), inArray(slackChannel.dmUser, t.them)),
      and(theirs, eq(slackMessage.mentionsMe, true)),
      and(yours, arrayOverlaps(slackMessage.mentions, t.them)),
      and(
        eq(slackChannel.kind, "group"),
        wroteHere(db, inArray(other.userId, t.them), false),
        wroteHere(db, eq(other.userId, t.me), false),
      ),
      and(
        inArray(slackChannel.kind, ["channel", "private"]),
        wroteHere(db, inArray(other.userId, t.them), true),
        wroteHere(db, eq(other.userId, t.me), true),
      ),
    ),
  );
}

const base = (db: DbOrTx, t: Talkers, since: Date | null) =>
  and(isNull(entity.deletedAt), shared(db, t), since ? gt(slackMessage.sentAt, since) : undefined);

/** How many messages of your talk came after `since` (all of it when null), counted up to `cap`. */
export async function talkCount(
  db: DbOrTx,
  t: Talkers,
  since: Date | null,
  cap: number,
): Promise<number> {
  const rows = await db
    .select({ id: slackMessage.entityId })
    .from(slackMessage)
    .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
    .innerJoin(entity, eq(entity.id, slackMessage.entityId))
    .where(base(db, t, since))
    .limit(cap);
  return rows.length;
}

/** The newest `limit` messages of your talk, oldest first. */
export async function talkLines(db: DbOrTx, t: Talkers, limit: number): Promise<TalkLine[]> {
  const rows = await db
    .select({
      at: slackMessage.sentAt,
      user: slackMessage.userId,
      kind: slackChannel.kind,
      channel: slackChannel.name,
      text: entity.body,
    })
    .from(slackMessage)
    .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
    .innerJoin(entity, eq(entity.id, slackMessage.entityId))
    .where(base(db, t, null))
    .orderBy(desc(slackMessage.sentAt))
    .limit(limit);
  return rows.reverse().map((r) => ({
    at: r.at,
    mine: r.user === t.me,
    where:
      r.kind === "dm"
        ? "a direct message"
        : r.kind === "group"
          ? "a group message"
          : `#${named(r.channel)}`,
    text: r.text ?? "",
  }));
}
