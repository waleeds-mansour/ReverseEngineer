// The inbox by bundle (bundles.ts), for the Mail page and Pip: how many conversations each bundle
// holds and who they're mostly from (mail.bundles), and moving a conversation to another bundle by
// hand (mail.set_bundle), which sync never undoes until it's let go to the rules again. Sorting
// your own mail is internal, so Pip does it on its own.
import { type DbOrTx, type MailAddress, mailAccount, mailThread } from "@hearth/db";
import { ActionError, defineAction } from "@hearth/kernel";
import { and, desc, eq, max, sql } from "drizzle-orm";
import { z } from "zod";
import { baseDomain } from "../people/domains.ts";
import { id } from "../shared.ts";
import { BUNDLES, isNoReply, type MailBundle } from "./bundles.ts";
import { recomputeThread } from "./flags.ts";
import { cleanName } from "./mime.ts";
import { addressKey } from "./mine.ts";
import { threadBundle } from "./views.ts";

export const bundle = z.enum(BUNDLES);

/** Each bundle as the inbox names it. */
export const BUNDLE_NAMES: Record<MailBundle, string> = {
  people: "People",
  updates: "Updates",
  receipts: "Receipts",
  newsletters: "Newsletters",
};

/** The newest inbox conversations looked at for who each bundle is from. */
const SENDERS_FROM = 400;
/** Senders named per bundle. */
const TOP = 3;

export interface BundleCount {
  bundle: MailBundle;
  /** Conversations of it in the inbox, and how many of those are unread. */
  count: number;
  unread: number;
  /** When its newest conversation last had a message. */
  latest: Date | null;
  /** Who it's mostly from, most conversations first: a sender's name, or their domain. */
  senders: string[];
}

/**
 * How a sender is named in a bundle's row: the name they always send with ("Vercel"), unless a
 * no-reply address carries someone else's name each time (GitHub's notices carry whoever acted),
 * when it's their domain ("github.com").
 */
function senderName(address: string, names: ReadonlySet<string>): string {
  const domain = baseDomain(address.slice(address.lastIndexOf("@") + 1));
  const [name] = names;
  if (names.size !== 1 || !name) return domain;
  const brand = domain.split(".")[0] ?? "";
  return !isNoReply(address) || name.toLowerCase().includes(brand) ? name : domain;
}

/** The senders most of these conversations are from, newest first among equals. */
function topSenders(rows: readonly { who: MailAddress[]; me: string }[]): string[] {
  const byAddress = new Map<string, { names: Set<string>; n: number }>();
  for (const r of rows) {
    const from = r.who.find((p) => addressKey(p.address) !== addressKey(r.me));
    if (!from) continue;
    const address = from.address.toLowerCase();
    const seen = byAddress.get(address) ?? { names: new Set<string>(), n: 0 };
    const name = cleanName(from.name);
    if (name) seen.names.add(name);
    seen.n++;
    byAddress.set(address, seen);
  }
  const byName = new Map<string, number>();
  for (const [address, { names, n }] of byAddress) {
    const name = senderName(address, names);
    byName.set(name, (byName.get(name) ?? 0) + n);
  }
  return [...byName]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP)
    .map(([name]) => name);
}

/** Every bundle of the inbox, People first, with its counts and senders; `account` for one. */
export async function countBundles(db: DbOrTx, account?: string): Promise<BundleCount[]> {
  const inbox = and(
    eq(mailThread.inInbox, true),
    eq(mailThread.trashed, false),
    account ? eq(mailAccount.address, account.toLowerCase()) : undefined,
  );
  const counts = await db
    .select({
      bundle: threadBundle,
      count: sql<number>`count(*)::int`,
      unread: sql<number>`(count(*) filter (where ${mailThread.unread}))::int`,
      latest: max(mailThread.lastMessageAt),
    })
    .from(mailThread)
    .innerJoin(mailAccount, eq(mailAccount.id, mailThread.accountId))
    .where(inbox)
    .groupBy(threadBundle);
  const recent = await db
    .select({ bundle: threadBundle, who: mailThread.participants, me: mailAccount.address })
    .from(mailThread)
    .innerJoin(mailAccount, eq(mailAccount.id, mailThread.accountId))
    .where(inbox)
    .orderBy(desc(mailThread.lastMessageAt), desc(mailThread.entityId))
    .limit(SENDERS_FROM);
  return BUNDLES.map((b) => {
    const c = counts.find((x) => x.bundle === b);
    return {
      bundle: b,
      count: c?.count ?? 0,
      unread: c?.unread ?? 0,
      latest: c?.latest ?? null,
      senders: topSenders(recent.filter((r) => r.bundle === b)),
    };
  });
}

const WHAT =
  "People (real conversations), Updates (notifications, shipping, accounts), Receipts (orders, invoices, payments) and Newsletters (lists, marketing)";

export const bundleActions = [
  defineAction({
    name: "mail.bundles",
    description: `The inbox by bundle: ${WHAT}. For each, how many conversations and how many unread, when the newest came, and who they're mostly from. List one bundle with mail.threads and bundle; move a conversation with mail.set_bundle.`,
    input: z.object({ account: z.string().email().optional() }),
    risk: "read",
    // Senders' names are written by the senders.
    external: true,
    handler: (i, ctx) => countBundles(ctx.tx, i.account),
  }),
  defineAction({
    name: "mail.set_bundle",
    description: `Move an email conversation to another bundle of the inbox: ${WHAT.toLowerCase()}. It stays where it's put: sync never sorts it again. For a conversation the rules sorted wrong, such as a person's email under Updates. auto: true instead lets the rules sort it again. Says where it was before (previous), to put it back.`,
    input: z.object({
      threadId: id.describe("The conversation's id."),
      bundle: bundle.optional().describe("Where it goes. Leave out with auto."),
      auto: z.boolean().optional().describe("true: sorted by the rules again, as if never moved."),
    }),
    risk: "internal",
    summarize: (i) =>
      i.bundle
        ? `Move a conversation to ${BUNDLE_NAMES[i.bundle]}`
        : "Let a conversation be sorted automatically again",
    async handler(i, ctx) {
      if (i.auto === true ? i.bundle !== undefined : i.bundle === undefined)
        throw new ActionError("invalid_input", "Give a bundle, or auto: true.");
      const where = eq(mailThread.entityId, i.threadId);
      const place = { bundle: threadBundle, moved: mailThread.bundleMoved };
      const [previous] = await ctx.tx.select(place).from(mailThread).where(where).for("update");
      if (!previous) throw new ActionError("not_found", "No email conversation with that id.");
      if (i.bundle)
        await ctx.tx.update(mailThread).set({ bundle: i.bundle, bundleMoved: true }).where(where);
      else {
        await ctx.tx.update(mailThread).set({ bundleMoved: false }).where(where);
        await recomputeThread(ctx, i.threadId);
      }
      const [now] = await ctx.tx.select(place).from(mailThread).where(where);
      ctx.emit({ kind: "mail.changed", entityId: i.threadId, payload: { bundle: now!.bundle } });
      return { threadId: i.threadId, ...now!, previous };
    },
  }),
];
