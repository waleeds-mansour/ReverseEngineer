// What a mail Undo needs to know, as things are now (undo-mail.ts, undo-mail-lane.ts): each
// message's flags, each conversation's bundle and "no reply" state, each sender's rule, and the
// later changes to the same conversations and senders. Read in one go for a whole list.
import { isUuid, PRINCIPAL } from "@hearth/core";
import { event, mailMessage, mailSenderRule, mailThread, type Tx } from "@hearth/db";
import { and, desc, eq, gt, inArray, or, type SQL, sql } from "drizzle-orm";
import { threadBundle } from "../mail/views.ts";
import type { Change } from "./undo-facts.ts";
import type { Inverse } from "./undo-read.ts";
import { WHY_NOT } from "./undo-words.ts";

export const MAIL_CHANGED = "mail.changed";
/** The most of Pip's mail changes read at once: apart from the rest, so a triage can't crowd it. */
export const MAX_MAIL = 2_000;
/** The most later changes looked at, newest first. */
const MAX_LATER = 5_000;

/** Pip's mail changes that say what was there before: the others have no Undo. */
export const mailUndoable = and(
  eq(event.kind, MAIL_CHANGED),
  sql`(${event.payload} -> 'before' IS NOT NULL OR ${event.payload} -> 'from' IS NOT NULL
    OR ${event.payload} -> 'pattern' IS NOT NULL
    OR (${event.entityId} IS NOT NULL AND ${event.payload} -> 'noReply' IS NOT NULL))`,
);

/** What an Undo is, before the reader adds which event and card it's for. */
export interface Piece {
  how: "made" | "trashed" | "changed";
  did: string;
  label: string;
  /** One change, or several for one line that stands for many (undo-group.ts). */
  inverse: Inverse | Inverse[];
  entityId: string | null;
  entityType: string | null;
  outside: boolean;
  /** Why what Pip did no longer stands, or null. */
  reality: string | null;
  /** What Undo put back still does. */
  stands: boolean;
  /** Why not once it's too old; null when age doesn't matter, unset for the usual week. */
  old?: string | null;
  /** What it did, for one line for many conversations done the same way in one go. */
  op?: string;
}

export interface Later {
  seq: number;
  actor: string;
  entityId: string | null;
  payload: Record<string, unknown>;
}

export interface MailFacts {
  /** Each message's flags now. */
  labels: Map<string, string[]>;
  threads: Map<string, { bundle: string; moved: boolean; noReply: boolean }>;
  /** Each sender's rule now, by its pattern. */
  rules: Map<string, string>;
  /** Later changes to the same conversations and senders, newest first. */
  later: Later[];
}

export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export const isLane = (v: unknown): v is "signal" | "noise" => v === "signal" || v === "noise";
const unique = <T>(xs: T[]) => [...new Set(xs)];

/** Each message's flags before, as the change recorded them. */
export function beforeOf(p: Record<string, unknown>): { id: string; had: Set<string> }[] {
  const b = p.before;
  if (!b || typeof b !== "object" || Array.isArray(b)) return [];
  return Object.entries(b as Record<string, unknown>).flatMap(([id, v]) =>
    isUuid(id) ? [{ id, had: new Set(strings(v)) }] : [],
  );
}

/** How things are now for these mail changes; null when there are none. */
export async function mailFactsOf(tx: Tx, changes: readonly Change[]): Promise<MailFacts | null> {
  const mail = changes.filter((e) => e.kind === MAIL_CHANGED);
  if (!mail.length) return null;
  const messageIds = unique(mail.flatMap((e) => beforeOf(e.payload).map((m) => m.id)));
  const threadIds = unique(mail.flatMap((e) => (e.entityId ? [e.entityId] : [])));
  const patterns = unique(mail.flatMap((e) => strings([e.payload.pattern])));
  const labels = messageIds.length
    ? await tx
        .select({ id: mailMessage.entityId, labels: mailMessage.labels })
        .from(mailMessage)
        .where(inArray(mailMessage.entityId, messageIds))
    : [];
  const threads = threadIds.length
    ? await tx
        .select({
          id: mailThread.entityId,
          bundle: threadBundle,
          moved: mailThread.bundleMoved,
          said: mailThread.noReplyCount,
          count: mailThread.messageCount,
        })
        .from(mailThread)
        .where(inArray(mailThread.entityId, threadIds))
    : [];
  const rules = patterns.length
    ? await tx.select().from(mailSenderRule).where(inArray(mailSenderRule.pattern, patterns))
    : [];
  const about: SQL[] = [];
  if (threadIds.length) about.push(inArray(event.entityId, threadIds));
  if (patterns.length) about.push(inArray(sql<string>`${event.payload} ->> 'pattern'`, patterns));
  // Newest first, so the limit leaves out the oldest.
  const later = about.length
    ? await tx
        .select({
          seq: event.seq,
          actor: event.actor,
          entityId: event.entityId,
          payload: event.payload,
        })
        .from(event)
        .where(
          and(
            eq(event.kind, MAIL_CHANGED),
            gt(event.seq, Math.min(...mail.map((e) => e.seq))),
            or(...about),
          ),
        )
        .orderBy(desc(event.seq))
        .limit(MAX_LATER)
    : [];
  return {
    labels: new Map(labels.map((m) => [m.id, m.labels])),
    threads: new Map(
      threads.map((t) => [
        t.id,
        // "Needs no reply" holds until a new message comes.
        { bundle: t.bundle, moved: t.moved, noReply: t.said !== null && t.said >= t.count },
      ]),
    ),
    rules: new Map(rules.map((r) => [r.pattern, r.lane])),
    later,
  };
}

/** Who changed it since, by a later change that `touches` it: you, or anyone else. */
export function changedSince(
  f: MailFacts,
  e: Change,
  same: (l: Later) => boolean,
  touches: (p: Record<string, unknown>) => boolean,
): string | null {
  const since = f.later.filter((l) => l.seq > e.seq && same(l) && touches(l.payload));
  if (!since.length) return null;
  return since.some((l) => l.actor === PRINCIPAL.owner) ? WHY_NOT.youChanged : WHY_NOT.changed;
}
