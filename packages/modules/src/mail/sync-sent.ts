// Sent mail an account missed. A draft sent from Gmail itself keeps its id and only moves from
// Drafts to Sent, and until the sync took that for new mail (gmail-api.ts changes), mail you sent
// there never came in. An account synced before then looks in Sent once, as far back as a first
// sync goes; a first sync (or a fresh start) brings Sent in with the rest.
import { mailMessage, mailQuarantine } from "@hearth/db";
import type { ActionContext } from "@hearth/kernel";
import { and, eq, gte, inArray } from "drizzle-orm";
import type { MailProvider } from "./provider.ts";
import type { AccountRow } from "./store.ts";
import { QUARANTINE_AFTER } from "./sync-aside.ts";
import type { SyncCursor } from "./sync-cursor.ts";

/** How far back it looks, as a first sync does, and at most how many: one page of Sent. */
export const SENT_DAYS = 30;
export const SENT_MAX = 200;

/**
 * Queues the sent mail Hearth doesn't have, newest first, and notes it looked. What's set aside,
 * or waiting to be tried again, stays where it is.
 */
export async function lookInSent(
  ctx: ActionContext,
  provider: MailProvider,
  account: AccountRow,
  c: SyncCursor,
): Promise<void> {
  const ids = await provider.sentSince(account.address, SENT_DAYS, SENT_MAX);
  c.lookedInSent = true;
  if (ids.length === 0) return;
  const known = await ctx.tx
    .select({ id: mailMessage.providerId })
    .from(mailMessage)
    .where(and(eq(mailMessage.accountId, account.id), inArray(mailMessage.providerId, ids)));
  const aside = await ctx.tx
    .select({ id: mailQuarantine.providerId })
    .from(mailQuarantine)
    .where(
      and(
        eq(mailQuarantine.accountId, account.id),
        inArray(mailQuarantine.providerId, ids),
        gte(mailQuarantine.attempts, QUARANTINE_AFTER),
      ),
    );
  const skip = new Set([
    ...known.map((k) => k.id),
    ...aside.map((q) => q.id),
    ...c.pending,
    ...Object.keys(c.parked),
  ]);
  c.pending.push(...ids.filter((id) => !skip.has(id)));
}
