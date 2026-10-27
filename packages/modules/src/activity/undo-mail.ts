// Undo for what Pip did to your mail on its own: archived, trashed, marked read or starred (or the
// opposite), moved back to the inbox, moved to another bundle, said needs no reply, or sent a sender
// to Signal or Noise (undo-mail-lane.ts). Each change's event says what was there before
// (mail/flags.ts, bundle-actions.ts, waiting.ts, lanes.ts), so Undo puts back just that, as you,
// and sends nothing. Greyed once it's changed since: by a later change in Nook (yours, or anyone's),
// or when it isn't as Pip left it (changed in Gmail, say). Many conversations done the same way in
// one go are one line (undo-group.ts).
import { BUNDLE_NAMES } from "../mail/bundle-actions.ts";
import { BUNDLES } from "../mail/bundles.ts";
import type { Change, Record_ } from "./undo-facts.ts";
import { beforeOf, changedSince, type MailFacts, type Piece, strings } from "./undo-mail-facts.ts";
import { lanePiece } from "./undo-mail-lane.ts";
import type { Inverse } from "./undo-read.ts";
import { bundleWords, type FlagOp, flagWords, noReplyWords, WHY_NOT } from "./undo-words.ts";

/** Gmail deletes what's in its trash for good after this long. */
const PURGE_DAYS = 30;

const isBundle = (v: unknown): v is (typeof BUNDLES)[number] =>
  (BUNDLES as readonly unknown[]).includes(v);

/** Each flag change Undo knows, by what it put on and took off. */
const FLAG_OPS: Record<string, FlagOp> = {
  "|INBOX": "archive",
  "TRASH|INBOX": "trash",
  "INBOX|TRASH": "unarchive",
  "INBOX|": "unarchive",
  "|UNREAD": "read",
  "UNREAD|": "unread",
  "STARRED|": "star",
  "|STARRED": "unstar",
};

/** What Undo runs for a flag change: what Pip took off goes back on, what it put on comes off. */
function flagInverse(
  op: FlagOp,
  ids: string[],
  had: (l: string) => string[],
  lacked: (l: string) => string[],
): Inverse | null {
  const run = (action: string, input: Record<string, unknown>, ...lists: string[][]) =>
    lists.some((l) => l.length) ? { action, input: { ids, ...input } } : null;
  switch (op) {
    case "archive":
      return run("mail.unarchive", { messages: had("INBOX") }, had("INBOX"));
    case "trash":
      return run(
        "mail.untrash",
        { messages: lacked("TRASH"), inbox: had("INBOX") },
        lacked("TRASH"),
      );
    case "unarchive":
      return run(
        "mail.rearchive",
        { messages: lacked("INBOX"), trash: had("TRASH") },
        lacked("INBOX"),
        had("TRASH"),
      );
    case "read":
    case "unread": {
      const messages = op === "read" ? had("UNREAD") : lacked("UNREAD");
      return run("mail.mark_read", { read: op === "unread", messages }, messages);
    }
    case "star":
    case "unstar": {
      const messages = op === "star" ? lacked("STARRED") : had("STARRED");
      return run("mail.star", { starred: op === "unstar", messages }, messages);
    }
  }
}

function flagPiece(e: Change, rec: Record_, f: MailFacts, now: Date): Piece | null {
  const add = strings(e.payload.add);
  const remove = strings(e.payload.remove);
  const op = FLAG_OPS[`${[...add].sort().join(",")}|${[...remove].sort().join(",")}`];
  const msgs = beforeOf(e.payload);
  if (!op || !msgs.length) return null;
  const had = (l: string) => msgs.filter((m) => m.had.has(l)).map((m) => m.id);
  const lacked = (l: string) => msgs.filter((m) => !m.had.has(l)).map((m) => m.id);
  const inverse = flagInverse(op, [rec.id], had, lacked);
  if (!inverse) return null;
  // Each message as Pip left it, and as Undo puts it back, for the flags it changed.
  const live = msgs.flatMap((m) => {
    const got = f.labels.get(m.id);
    return got ? [{ ...m, now: new Set(got) }] : [];
  });
  const left = live.every(
    (m) =>
      remove.every((l) => !m.had.has(l) || !m.now.has(l)) &&
      add.every((l) => m.had.has(l) || m.now.has(l)),
  );
  const back = live.every(
    (m) =>
      remove.every((l) => !m.had.has(l) || m.now.has(l)) &&
      add.every((l) => m.had.has(l) || !m.now.has(l)),
  );
  const flags = [...add, ...remove];
  const touches = (p: Record<string, unknown>) =>
    [...strings(p.add), ...strings(p.remove)].some((l) => flags.includes(l));
  // Gone for good only while it's still in the trash as Pip left it.
  const purged =
    op === "trash" && now.getTime() - e.at.getTime() >= PURGE_DAYS * 86_400_000
      ? WHY_NOT.purged
      : null;
  const reality = !live.length
    ? (purged ?? WHY_NOT.gone)
    : (changedSince(f, e, (l) => l.entityId === rec.id, touches) ??
      (left ? purged : WHY_NOT.changed));
  // A trash that put it back in the inbox, or moving back to the inbox one that was in the trash.
  const alt = op === "trash" ? had("INBOX").length > 0 : had("TRASH").length > 0;
  return {
    how: op === "trash" ? "trashed" : "changed",
    ...flagWords(op, rec.title, alt),
    inverse,
    entityId: rec.id,
    entityType: rec.type,
    outside: rec.outside,
    reality,
    stands: live.length > 0 && back,
    // A trash is good until Gmail empties it, not just the week.
    ...(op === "trash" ? { old: null } : {}),
    op,
  };
}

function bundlePiece(e: Change, rec: Record_, f: MailFacts): Piece | null {
  const p = e.payload;
  const t = f.threads.get(rec.id);
  if (!t || !isBundle(p.bundle) || !isBundle(p.from)) return null;
  const moved = p.moved === true;
  const fromMoved = p.fromMoved === true;
  if (p.bundle === p.from && moved === fromMoved) return null;
  const left = moved ? t.moved && t.bundle === p.bundle : !t.moved;
  const back = fromMoved ? t.moved && t.bundle === p.from : !t.moved;
  const reality =
    changedSince(
      f,
      e,
      (l) => l.entityId === rec.id,
      (q) => "bundle" in q,
    ) ?? (left ? null : WHY_NOT.changed);
  const to = moved ? BUNDLE_NAMES[p.bundle] : null;
  return {
    how: "changed",
    ...bundleWords(rec.title, to, BUNDLE_NAMES[p.from]),
    inverse: {
      action: "mail.set_bundle",
      input: fromMoved ? { threadId: rec.id, bundle: p.from } : { threadId: rec.id, auto: true },
    },
    entityId: rec.id,
    entityType: rec.type,
    outside: rec.outside,
    reality,
    stands: back,
    op: `bundle:${to ?? ""}`,
  };
}

/** Said needs no reply (mail.no_reply), or that it needs one after all. */
function noReplyPiece(e: Change, rec: Record_, f: MailFacts): Piece | null {
  const t = f.threads.get(rec.id);
  if (!t || typeof e.payload.noReply !== "boolean") return null;
  const said = e.payload.noReply;
  // It holds until a new message comes, which is a change since too.
  const left = t.noReply === said;
  const reality =
    changedSince(
      f,
      e,
      (l) => l.entityId === rec.id,
      (q) => "noReply" in q,
    ) ?? (left ? null : WHY_NOT.changed);
  return {
    how: "changed",
    ...noReplyWords(rec.title, said),
    inverse: { action: "mail.no_reply", input: { ids: [rec.id], needed: said } },
    entityId: rec.id,
    entityType: rec.type,
    outside: rec.outside,
    reality,
    stands: !left,
    op: said ? "no_reply" : "needs_reply",
  };
}

/** The Undo of one of Pip's mail changes, or null when it has none. */
export function mailPiece(
  e: Change,
  rec: Record_ | undefined,
  f: MailFacts | null,
  now: Date,
): Piece | null {
  if (!f) return null;
  if (!e.entityId) return lanePiece(e, f);
  if (rec?.type !== "email_thread") return null;
  if ("from" in e.payload) return bundlePiece(e, rec, f);
  if ("noReply" in e.payload) return noReplyPiece(e, rec, f);
  return flagPiece(e, rec, f, now);
}
