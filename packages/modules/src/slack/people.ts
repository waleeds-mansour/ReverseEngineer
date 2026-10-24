// People from Slack, by the rule mail follows (mail/people.ts): someone you've talked with becomes
// a person. In Slack that's a DM or a group DM, a thread you both wrote in, or an @mention either
// way, never the whole workspace. Bots and deactivated users are no one, and a guest or someone
// from another org (Slack Connect) is someone only once you've written to them. Their Slack email
// is the person's address, so their mail and their Slack meet in one person; someone you put in
// the trash stays there, and a desk's address (support@) is no one (ensurePerson). Each message is
// looked at once, so what was read in before this is looked at over the next rounds.
import {
  type DbOrTx,
  type SlackChannelKind,
  slackChannel,
  slackMessage,
  slackUser,
} from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { accountAddresses, addressKey } from "../mail/mine.ts";
import { isMachineAddress } from "../people/domains.ts";
import { ensurePerson, personFor } from "../people/store.ts";
import { SlackError } from "./api.ts";
import { linkEarlier, profileOf, slackApi, type WorkspaceRow } from "./save.ts";

/** Messages looked at a round, and users.info lookups (Slack allows about 100 a minute). */
const PER_ROUND = 500;
const LOOKUPS = 15;
/** A profile is read again after this long: titles and time zones change, and people leave. */
const PROFILE_EVERY_MS = 7 * 86_400_000;

/** You wrote to them (or with them), or they only wrote to you. */
type Contact = "wrote" | "heard";

interface Seen {
  id: string;
  channelId: string;
  kind: SlackChannelKind;
  dmUser: string | null;
  ts: string;
  threadTs: string | null;
  userId: string | null;
  mentionsMe: boolean;
  mentions: string[] | null;
}

/** A DM or a group DM is one conversation; in a channel, a thread is (by its start). */
const placeOf = (m: Pick<Seen, "channelId" | "kind" | "ts" | "threadTs">) =>
  m.kind === "dm" || m.kind === "group" ? m.channelId : `${m.channelId}/${m.threadTs ?? m.ts}`;

/**
 * Who wrote in each conversation the messages are in, ever. A channel message that isn't a reply
 * needs no look: a reply to it, when one comes, is looked at with its thread.
 */
async function writersOf(db: DbOrTx, batch: Seen[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const note = (place: string, user: string | null) => {
    if (user) (out.get(place) ?? out.set(place, new Set()).get(place)!).add(user);
  };
  const dms = [...new Set(batch.filter((m) => placeOf(m) === m.channelId).map((m) => m.channelId))];
  if (dms.length)
    for (const r of await db
      .selectDistinct({ channel: slackMessage.channelId, user: slackMessage.userId })
      .from(slackMessage)
      .where(inArray(slackMessage.channelId, dms)))
      note(r.channel, r.user);
  const threads = new Map<string, Set<string>>();
  for (const m of batch)
    if (m.threadTs && placeOf(m) !== m.channelId)
      (threads.get(m.channelId) ?? threads.set(m.channelId, new Set()).get(m.channelId)!).add(
        m.threadTs,
      );
  // One after another: a transaction takes one query at a time.
  for (const [channel, starts] of threads) {
    const list = [...starts];
    for (const r of await db
      .selectDistinct({
        ts: slackMessage.ts,
        start: slackMessage.threadTs,
        user: slackMessage.userId,
      })
      .from(slackMessage)
      .where(
        and(
          eq(slackMessage.channelId, channel),
          or(inArray(slackMessage.ts, list), inArray(slackMessage.threadTs, list)),
        ),
      ))
      note(`${channel}/${r.start ?? r.ts}`, r.user);
  }
  return out;
}

/** Everyone these messages show you talking with, and which messages show it. */
async function talkedWith(db: DbOrTx, me: string, batch: Seen[]) {
  const out = new Map<string, { contact: Contact; messages: Set<string> }>();
  const add = (user: string | null | undefined, contact: Contact, m: Seen) => {
    if (!user || user === me) return;
    const was = out.get(user);
    if (!was) return void out.set(user, { contact, messages: new Set([m.id]) });
    if (contact === "wrote") was.contact = "wrote";
    was.messages.add(m.id);
  };
  const writers = await writersOf(db, batch);
  for (const m of batch) {
    const mine = m.userId === me;
    if (mine && m.kind === "dm") add(m.dmUser, "wrote", m);
    if (mine) for (const u of m.mentions ?? []) add(u, "wrote", m);
    // A direct message from them, or an @mention of you.
    if (!mine && m.mentionsMe) add(m.userId, "heard", m);
    const together = writers.get(placeOf(m));
    if (mine) for (const u of together ?? []) add(u, "wrote", m);
    else if (together?.has(me)) add(m.userId, "wrote", m);
  }
  return out;
}

/** What a round may still ask Slack about people, and why it stopped asking, when it did. */
type Lookups = { left: number; stopped?: string };
type Known = typeof slackUser.$inferSelect;

/** What Slack says of them now, read again once it's a week old. Null: not this round. */
async function facts(
  ctx: ActionContext,
  ws: WorkspaceRow,
  token: string,
  id: string,
  known: Known | undefined,
  lookups: Lookups,
): Promise<(Known & { realName?: string }) | null> {
  const fresh =
    known?.checkedAt && ctx.now.getTime() - known.checkedAt.getTime() < PROFILE_EVERY_MS;
  if (known && fresh) return known;
  if (lookups.left <= 0) return null;
  lookups.left--;
  let u: Awaited<ReturnType<ReturnType<typeof slackApi>["user"]>>;
  try {
    u = await slackApi(ctx).user(token, id);
  } catch (err) {
    // Slowed down or refused: the rest waits a round, as the member check does (member/check.ts).
    lookups.left = 0;
    lookups.stopped = err instanceof SlackError ? err.code : "unreachable";
    return null;
  }
  const flags = {
    email: u?.email?.toLowerCase() ?? null,
    bot: u?.bot ?? false,
    guest: u?.guest ?? false,
    external: Boolean(u?.teamId && u.teamId !== ws.teamId),
    // Slack doesn't know them: they're no one.
    deleted: u ? Boolean(u.deleted) : true,
    checkedAt: ctx.now,
    ...(u ? profileOf(u) : {}),
  };
  const [row] = await ctx.tx
    .insert(slackUser)
    .values({ id, teamId: ws.teamId, name: (u?.name ?? id).slice(0, 200), ...flags })
    .onConflictDoUpdate({ target: slackUser.id, set: flags })
    .returning();
  return { ...row!, ...(u?.realName ? { realName: u.realName } : {}) };
}

/**
 * Makes someone you talked with a person, or finds who they already are. "later" when Slack
 * couldn't be asked about them this round.
 */
async function meet(
  ctx: ActionContext,
  ws: WorkspaceRow,
  token: string,
  id: string,
  contact: Contact,
  lookups: Lookups,
  mine: ReadonlySet<string>,
): Promise<"met" | "no" | "later"> {
  const [known] = await ctx.tx.select().from(slackUser).where(eq(slackUser.id, id));
  // Already someone you know: their profile is kept fresh while you talk, when there's room.
  if (known?.email && known.personId && (await personFor(ctx.tx, known.email)) === known.personId) {
    if (lookups.left > 0) await facts(ctx, ws, token, id, known, lookups);
    return "no";
  }
  const u = await facts(ctx, ws, token, id, known, lookups);
  if (!u) return "later";
  if (u.bot || u.deleted || id === "USLACKBOT") return "no";
  // A guest or another org's: only once you've written to them.
  if ((u.guest || u.external) && contact !== "wrote") return "no";
  const email = u.email;
  // No email, a desk's or your own: no one to make. Nor for someone in the trash (ensurePerson).
  if (!email || isMachineAddress(email) || mine.has(addressKey(email))) return "no";
  const personId = await ensurePerson(ctx, { address: email, name: u.realName || u.name });
  if (!personId) return "no";
  if (u.personId !== personId) {
    await ctx.tx.update(slackUser).set({ personId }).where(eq(slackUser.id, id));
    await linkEarlier(ctx, id, personId);
  }
  return "met";
}

/**
 * A round's look: how many became people (or were found to be someone you know), and why Slack
 * stopped being asked about people, when it was.
 */
export interface Met {
  met: number;
  stopped?: string;
}

/** Looks at messages not yet looked at for the people in them: the oldest first, a round's worth. */
export async function meetPeople(
  ctx: ActionContext,
  ws: WorkspaceRow,
  token: string,
): Promise<Met> {
  const batch: Seen[] = await ctx.tx
    .select({
      id: slackMessage.entityId,
      channelId: slackMessage.channelId,
      kind: slackChannel.kind,
      dmUser: slackChannel.dmUser,
      ts: slackMessage.ts,
      threadTs: slackMessage.threadTs,
      userId: slackMessage.userId,
      mentionsMe: slackMessage.mentionsMe,
      mentions: slackMessage.mentions,
    })
    .from(slackMessage)
    .innerJoin(slackChannel, eq(slackChannel.id, slackMessage.channelId))
    .where(and(eq(slackChannel.teamId, ws.teamId), eq(slackMessage.peopleLinked, false)))
    .orderBy(asc(slackMessage.sentAt))
    .limit(PER_ROUND);
  if (!batch.length) return { met: 0 };
  const talked = await talkedWith(ctx.tx, ws.userId, batch);
  // Jarvis's own bot is no one.
  if (ws.jarvis) talked.delete(ws.jarvis.botUserId);
  const mine = await accountAddresses(ctx.tx);
  const lookups: Lookups = { left: LOOKUPS };
  const waiting = new Set<string>();
  let met = 0;
  for (const [id, { contact, messages }] of talked) {
    const r = await meet(ctx, ws, token, id, contact, lookups, mine);
    if (r === "met") met++;
    if (r === "later") for (const m of messages) waiting.add(m);
  }
  const done = batch.map((m) => m.id).filter((id) => !waiting.has(id));
  if (done.length)
    await ctx.tx
      .update(slackMessage)
      .set({ peopleLinked: true })
      .where(inArray(slackMessage.entityId, done));
  return { met, ...(lookups.stopped ? { stopped: lookups.stopped } : {}) };
}
