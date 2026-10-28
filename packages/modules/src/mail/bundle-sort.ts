// Sorting conversations into bundles (bundles.ts) from what's stored: each time sync saves a
// message or a flag changes, its conversation is sorted again (flags.ts recomputeThread), and the
// conversations from before bundles (0058) are sorted a batch a round by each account's sync.
// Once after Nook starts, each account's newest inbox is sorted again, so a change to the rules
// reaches mail sorted before it. A conversation moved by hand is never sorted again.
import {
  type DbOrTx,
  entity,
  type MailLane,
  mailMessage,
  mailSenderRule,
  mailThread,
  personEmail,
} from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { type BundleMessage, bundleOf, factsOf, type MailBundle } from "./bundles.ts";
import { once } from "./copies.ts";
import { accountAddresses } from "./mine.ts";
import { senderPatterns } from "./people.ts";

/** Conversations sorted per sync round: a few database reads, no Gmail. */
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

/**
 * Which of these senders you sent to Noise yourself (mail.set_lane), by their most specific rule
 * as people.ts ruleFor reads them. A conversation is in Noise for Gmail's tab too (laneFor: a
 * stranger's mail outside Primary), and that's no word of yours on them: a colleague's post to a
 * group is in Gmail's Forums.
 */
async function sentToNoise(db: DbOrTx, addresses: readonly string[]): Promise<Set<string>> {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean))];
  if (list.length === 0) return new Set();
  const rules = await db
    .select({ pattern: mailSenderRule.pattern, lane: mailSenderRule.lane })
    .from(mailSenderRule)
    .where(inArray(mailSenderRule.pattern, [...new Set(list.flatMap(senderPatterns))]));
  const lanes = new Map<string, MailLane>(rules.map((r) => [r.pattern, r.lane]));
  const ruled = (a: string) => senderPatterns(a).find((p) => lanes.has(p));
  return new Set(list.filter((a) => lanes.get(ruled(a) ?? "") === "noise"));
}

/** The newest message from someone else, whose sender and Reply-To the rules read. */
const newest = (msgs: readonly BundleMessage[]) => msgs.filter((m) => !m.outbound).slice(-1);
/** The addresses factsOf may ask about: who sent it, and Reply-To. */
const asked = (lasts: readonly BundleMessage[]) =>
  lasts.flatMap((m) => [m.fromAddress, m.replyTo ?? ""]);

/** Your accounts' addresses, read once a transaction: a sync sorts many conversations in one. */
const accountsByTx = new WeakMap<object, Promise<Set<string>>>();
function accountsIn(db: DbOrTx): Promise<Set<string>> {
  let read = accountsByTx.get(db);
  if (!read) {
    read = accountAddresses(db);
    accountsByTx.set(db, read);
    read.catch(() => accountsByTx.delete(db));
  }
  return read;
}

/** Noise as the rules take it: a rule of yours (true), Gmail's tab alone ("tab"), or none. */
const noiseOf = (inNoise: boolean, ruled: boolean) => (inNoise ? ruled || "tab" : false);

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
  const last = newest(msgs);
  const known = await knownAddresses(db, asked(last));
  const senders = last.map((m) => m.fromAddress);
  const ruled = noise && (await sentToNoise(db, senders)).size > 0;
  return bundleOf(factsOf(msgs, me, known, noiseOf(noise, ruled), await accountsIn(db)));
}

type Sortable = { id: string; lane: string };

/**
 * Where each of an account's conversations sorts by the rules, as recomputeThread would sort it:
 * what's in the trash has no say while anything else is left, and an email in two of your
 * accounts counts once. A few reads for the lot.
 */
async function sortAll(
  db: DbOrTx,
  account: { address: string },
  threads: readonly Sortable[],
): Promise<Map<string, MailBundle>> {
  const rows = await db
    .select({
      threadId: mailMessage.threadId,
      accountId: mailMessage.accountId,
      copyKey: mailMessage.copyKey,
      outbound: mailMessage.outbound,
      fromAddress: mailMessage.fromAddress,
      replyTo: mailMessage.replyTo,
      toAddresses: mailMessage.toAddresses,
      ccAddresses: mailMessage.ccAddresses,
      subject: entity.title,
      labels: mailMessage.labels,
      bulk: mailMessage.bulk,
      invite: mailMessage.invite,
    })
    .from(mailMessage)
    .innerJoin(entity, eq(entity.id, mailMessage.entityId))
    .where(
      inArray(
        mailMessage.threadId,
        threads.map((t) => t.id),
      ),
    )
    .orderBy(asc(mailMessage.sentAt), asc(mailMessage.entityId));
  const byThread = new Map<string, typeof rows>();
  for (const r of rows) {
    const msgs = byThread.get(r.threadId);
    if (msgs) msgs.push(r);
    else byThread.set(r.threadId, [r]);
  }
  const shown = new Map<string, BundleMessage[]>();
  for (const [id, msgs] of byThread) {
    const kept = msgs.filter((m) => !m.labels.includes("TRASH"));
    shown.set(id, once(kept.length ? kept : msgs));
  }
  const lasts = new Map([...shown].map(([id, msgs]) => [id, newest(msgs)]));
  const known = await knownAddresses(db, asked([...lasts.values()].flat()));
  const inNoise = threads.filter((t) => t.lane === "noise");
  const ruled = await sentToNoise(
    db,
    inNoise.flatMap((t) => lasts.get(t.id) ?? []).map((m) => m.fromAddress),
  );
  const mine = await accountsIn(db);
  const out = new Map<string, MailBundle>();
  for (const { id, lane } of threads) {
    const from = lasts.get(id)?.[0]?.fromAddress.toLowerCase() ?? "";
    const noise = noiseOf(lane === "noise", ruled.has(from));
    out.set(id, bundleOf(factsOf(shown.get(id) ?? [], account.address, known, noise, mine)));
  }
  return out;
}

/**
 * Sorts up to SORT_BATCH of an account's conversations that have no bundle yet, the inbox first
 * and newest first, so what you look at is sorted soonest; with none left, sorts the inbox again
 * after Nook starts (sortAgain). A few reads and a write per bundle, so a round's sync isn't held
 * up. Returns how many it sorted.
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
  if (threads.length === 0) return sortAgain(ctx, account);
  const sorted = await sortAll(ctx.tx, account, threads);
  const some = new Map<MailBundle, string[]>();
  for (const [id, bundle] of sorted) some.set(bundle, [...(some.get(bundle) ?? []), id]);
  // Only ones still unsorted: a message saved or a move made meanwhile has sorted it already.
  for (const [bundle, ids] of some)
    await ctx.tx
      .update(mailThread)
      .set({ bundle })
      .where(and(inArray(mailThread.entityId, ids), isNull(mailThread.bundle)));
  return threads.length;
}

/**
 * Rounds of sorting again each account has had since Nook started: done after a round that moves
 * nothing, or at AGAIN_ROUNDS whatever happens. Tests clear it, as a restart would.
 */
export const sortedAgain = new Map<string, number>();
export const AGAIN_ROUNDS = 3;

/**
 * The account's newest SORT_BATCH inbox conversations sorted by the rules again after Nook starts,
 * so rules that changed with an update reach mail they sorted before (a person writing through a
 * list, sorted into Newsletters before M-02). A round at a time till one finds nothing to move, so
 * a round whose writes were undone is done again. Never one moved by hand, nor one whose
 * bundle changed since it was read (a new message, a lane). Returns how many moved.
 */
async function sortAgain(
  ctx: ActionContext,
  account: { id: string; address: string },
): Promise<number> {
  const round = sortedAgain.get(account.id) ?? 0;
  if (round >= AGAIN_ROUNDS) return 0;
  const threads = await ctx.tx
    .select({ id: mailThread.entityId, lane: mailThread.lane, bundle: mailThread.bundle })
    .from(mailThread)
    .where(
      and(
        eq(mailThread.accountId, account.id),
        eq(mailThread.inInbox, true),
        eq(mailThread.bundleMoved, false),
        isNotNull(mailThread.bundle),
      ),
    )
    .orderBy(desc(mailThread.lastMessageAt), desc(mailThread.entityId))
    .limit(SORT_BATCH);
  const none = new Map<string, MailBundle>();
  const sorted = threads.length ? await sortAll(ctx.tx, account, threads) : none;
  // By where each was and where it goes: written only if still where it was.
  const moves = new Map<string, { from: MailBundle; to: MailBundle; ids: string[] }>();
  for (const t of threads) {
    const to = sorted.get(t.id);
    if (!t.bundle || !to || to === t.bundle) continue;
    const key = `${t.bundle}>${to}`;
    const move = moves.get(key) ?? { from: t.bundle, to, ids: [] };
    move.ids.push(t.id);
    moves.set(key, move);
  }
  let moved = 0;
  for (const { from, to, ids } of moves.values()) {
    const done = await ctx.tx
      .update(mailThread)
      .set({ bundle: to })
      .where(
        and(
          inArray(mailThread.entityId, ids),
          eq(mailThread.bundleMoved, false),
          eq(mailThread.bundle, from),
        ),
      )
      .returning({ id: mailThread.entityId });
    moved += done.length;
  }
  sortedAgain.set(account.id, moved === 0 ? AGAIN_ROUNDS : round + 1);
  if (moved) console.info(`[mail] sorted ${moved} conversations of account ${account.id} again`);
  return moved;
}
