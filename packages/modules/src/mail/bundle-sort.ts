// Sorting conversations into bundles (bundles.ts) from what's stored: each time sync saves a
// message or a flag changes, its conversation is sorted again (flags.ts recomputeThread), and the
// conversations from before bundles (0058) are sorted a batch a round by each account's sync. One
// moved by hand is never sorted again.
import { type DbOrTx, entity, mailMessage, mailThread, personEmail } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { type BundleMessage, bundleOf, factsOf, type MailBundle } from "./bundles.ts";

/** Conversations from before bundles sorted per sync round: a few database reads, no Gmail. */
export const SORT_BATCH = 500;

/** Which of these addresses are someone you know: a person in Nook, not in the trash. */
export async function knownAddresses(
  db: DbOrTx,
  addresses: readonly string[],
): Promise<Set<string>> {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean))];
  if (list.length === 0) return new Set();
  const rows = await db
    .select({ address: personEmail.address })
    .from(personEmail)
    .innerJoin(entity, eq(entity.id, personEmail.personId))
    .where(and(inArray(personEmail.address, list), isNull(entity.deletedAt)));
  return new Set(rows.map((r) => r.address.toLowerCase()));
}

/** The addresses factsOf may ask about: who sent each message from someone else, and Reply-To. */
const asked = (msgs: readonly BundleMessage[]) =>
  msgs.filter((m) => !m.outbound).flatMap((m) => [m.fromAddress, m.replyTo ?? ""]);

/**
 * The bundle a conversation sorts into, from its messages oldest first; `me` is its account, and
 * `noise` says its lane is Noise.
 */
export async function bundleFor(
  db: DbOrTx,
  msgs: readonly BundleMessage[],
  me: string,
  noise: boolean,
): Promise<MailBundle> {
  const last = msgs.filter((m) => !m.outbound).slice(-1);
  return bundleOf(factsOf(msgs, me, await knownAddresses(db, asked(last)), noise));
}

/**
 * Sorts up to SORT_BATCH of an account's conversations that have no bundle yet, the inbox first
 * and newest first, so what you look at is sorted soonest. Three reads and a write per bundle,
 * so a round's sync isn't held up. Returns how many it sorted.
 */
export async function sortSome(
  ctx: ActionContext,
  account: { id: string; address: string },
): Promise<number> {
  const threads = await ctx.tx
    .select({ id: mailThread.entityId, lane: mailThread.lane })
    .from(mailThread)
    .where(and(eq(mailThread.accountId, account.id), isNull(mailThread.bundle)))
    .orderBy(desc(mailThread.inInbox), desc(mailThread.lastMessageAt), desc(mailThread.entityId))
    .limit(SORT_BATCH);
  if (threads.length === 0) return 0;
  const ids = threads.map((t) => t.id);
  const rows = await ctx.tx
    .select({
      threadId: mailMessage.threadId,
      outbound: mailMessage.outbound,
      fromAddress: mailMessage.fromAddress,
      replyTo: mailMessage.replyTo,
      subject: entity.title,
      labels: mailMessage.labels,
      bulk: mailMessage.bulk,
      invite: mailMessage.invite,
    })
    .from(mailMessage)
    .innerJoin(entity, eq(entity.id, mailMessage.entityId))
    .where(inArray(mailMessage.threadId, ids))
    .orderBy(asc(mailMessage.sentAt), asc(mailMessage.entityId));
  const byThread = new Map<string, BundleMessage[]>();
  for (const r of rows) {
    const msgs = byThread.get(r.threadId);
    if (msgs) msgs.push(r);
    else byThread.set(r.threadId, [r]);
  }
  // As recomputeThread sorts: what's in the trash has no say while anything else is left.
  const live = (msgs: BundleMessage[]) => {
    const kept = msgs.filter((m) => !m.labels.includes("TRASH"));
    return kept.length ? kept : msgs;
  };
  const lasts = [...byThread.values()].flatMap((msgs) =>
    live(msgs)
      .filter((m) => !m.outbound)
      .slice(-1),
  );
  const known = await knownAddresses(ctx.tx, asked(lasts));
  const sorted = new Map<MailBundle, string[]>();
  for (const { id, lane } of threads) {
    const msgs = live(byThread.get(id) ?? []);
    const bundle = bundleOf(factsOf(msgs, account.address, known, lane === "noise"));
    const some = sorted.get(bundle);
    if (some) some.push(id);
    else sorted.set(bundle, [id]);
  }
  // Only ones still unsorted: a message saved or a move made meanwhile has sorted it already.
  for (const [bundle, some] of sorted)
    await ctx.tx
      .update(mailThread)
      .set({ bundle })
      .where(and(inArray(mailThread.entityId, some), isNull(mailThread.bundle)));
  return ids.length;
}
