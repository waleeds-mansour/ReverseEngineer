// What Pip did, as one timeline: each thing that set Pip off (your ask, a routine, something it
// noticed) with every action it ran, the approvals it asked for and how they went, the records it
// touched, the heartbeat items it took up, and its reply. Read from what Hearth recorded
// (jarvis_turn, audit, approval, event, heartbeat_item), grouped by correlation id: a turn's own id
// is the correlation of every call it makes, so a turn and all it did read as one card.
//
// None of those tables has an index on correlation_id, so every read is bounded by time first:
// a page is the latest `limit` turns, and the window runs from the oldest of them.
import { PRINCIPAL } from "@hearth/core";
import { approval, audit, entity, event, heartbeatItem, jarvisTurn, type Tx } from "@hearth/db";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, type SQL, sql } from "drizzle-orm";
import {
  HOW,
  type How,
  ITEM,
  itemIdsOf,
  latest,
  type Timeline,
  type TimelineGroup,
  TURN,
  type TurnRow,
  turnOf,
} from "./shape.ts";
import { undidGroups } from "./undo.ts";
import { shown, undosOf } from "./undo-read.ts";
import { clip, inputWords, recordIn } from "./words.ts";

/** How far back a page looks when there are fewer turns than it asks for. */
const QUIET_DAYS = 7;
/** Bounds on what one page reads, so a busy day can't make it slow. */
const MAX_AUDIT = 1_500;
const MAX_EVENTS = 2_000;
const MAX_ACTIONS = 60;
const MAX_TOUCHED = 20;
/** Events are stamped by their writer's clock, so seq order and time order can differ a little. */
const SKEW_MS = 60_000;

/**
 * A page of the timeline, newest first: the latest `limit` turns and all Pip did around them. With
 * a job (`roleId`, Spec 3), only that job's turns and what they did.
 */
export async function readTimeline(
  tx: Tx,
  i: { limit: number; before?: string | undefined; roleId?: string | undefined },
  now: Date,
): Promise<Timeline> {
  const end = i.before ? new Date(i.before) : now;
  const turns: TurnRow[] = await tx
    .select(TURN)
    .from(jarvisTurn)
    .where(
      and(
        i.before ? lt(jarvisTurn.queuedAt, end) : undefined,
        i.roleId ? eq(jarvisTurn.roleId, i.roleId) : undefined,
      ),
    )
    .orderBy(desc(jarvisTurn.queuedAt))
    .limit(i.limit);
  const full = turns.length === i.limit;
  const oldest = turns.at(-1)?.queuedAt;
  const quiet = end.getTime() - QUIET_DAYS * 86_400_000;
  const since = full && oldest ? oldest : new Date(Math.min(oldest?.getTime() ?? quiet, quiet));
  const turnIds = turns.map((t) => t.id);
  // A later page ends where the one before it began; the first runs up to now.
  const upTo = (col: Parameters<typeof lt>[0]) => (i.before ? lt(col, end) : undefined);

  // Everything Pip did in the window, and anything the page's turns did after it (a yes later).
  // A job's page has only what its turns did: Pip's other work isn't the job's.
  const ofTurns = (col: Parameters<typeof inArray>[0]): SQL =>
    turnIds.length ? inArray(col, turnIds) : sql`false`;
  const allPip = (cond: SQL | undefined) => (i.roleId ? undefined : cond);
  const actions = await tx
    .select()
    .from(audit)
    .where(
      and(
        gte(audit.at, since),
        or(
          ofTurns(audit.correlationId),
          allPip(and(eq(audit.principal, PRINCIPAL.jarvis), upTo(audit.at))),
        ),
      ),
    )
    .orderBy(desc(audit.at))
    .limit(MAX_AUDIT);
  const asks = await tx
    .select()
    .from(approval)
    .where(
      and(
        // Asked in the window, or answered in it.
        or(gte(approval.createdAt, since), gte(approval.decidedAt, since)),
        or(
          ofTurns(approval.correlationId),
          ofTurns(approval.turnId),
          allPip(and(eq(approval.requestedBy, PRINCIPAL.jarvis), upTo(approval.createdAt))),
        ),
      ),
    );
  const keyOf = (a: (typeof asks)[number]) => a.turnId ?? a.correlationId ?? a.id;

  // A correlation that isn't one of the page's turns may still be a turn: an older one whose
  // approval came through in the window. Its card shows the turn too.
  const known = new Set(turnIds);
  const others = [
    ...new Set([
      ...actions.flatMap((a) => (a.correlationId ? [a.correlationId] : [])),
      ...asks.map(keyOf),
    ]),
  ].filter((k) => !known.has(k));
  if (others.length) {
    const older = await tx.select(TURN).from(jarvisTurn).where(inArray(jarvisTurn.id, others));
    turns.push(...older);
    await addOlder(tx, older, since, actions, asks);
  }
  const allTurnIds = turns.map((t) => t.id);

  const groups = new Map<string, TimelineGroup & { touchedBy: Map<string, How> }>();
  const group = (id: string, at: number) => {
    let g = groups.get(id);
    if (!g) {
      g = {
        id,
        at: new Date(at),
        turn: null,
        actions: [],
        approvals: [],
        touched: [],
        setAside: [],
        undos: [],
        undid: null,
        touchedBy: new Map(),
      };
      groups.set(id, g);
    }
    if (at > g.at.getTime()) g.at = new Date(at);
    return g;
  };
  for (const t of turns)
    group(t.id, latest(t.queuedAt, t.startedAt, t.finishedAt)).turn = turnOf(t);
  // An action whose input names a record says that record's title, read below: a reply's draft
  // says the thread's subject, not the start of its text. Otherwise, what its input says.
  const recordOf = new Map<string, string>();
  for (const a of actions.sort((x, y) => x.at.getTime() - y.at.getTime())) {
    if (!a.correlationId) continue;
    const g = group(a.correlationId, a.at.getTime());
    if (g.actions.length >= MAX_ACTIONS) continue;
    const record = recordIn(a.input);
    if (record) recordOf.set(a.id, record);
    g.actions.push({
      id: a.id,
      at: a.at,
      action: a.action,
      risk: a.risk,
      outcome: a.outcome,
      error: clip(a.error, 300),
      durationMs: a.durationMs,
      approvalId: a.approvalId,
      what: inputWords(a.input),
    });
  }
  for (const a of asks.sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
    group(keyOf(a), latest(a.createdAt, a.decidedAt)).approvals.push({
      id: a.id,
      action: a.action,
      summary: a.summary,
      status: a.status,
      error: clip(a.error, 300),
      createdAt: a.createdAt,
      decidedAt: a.decidedAt,
    });
  }

  // What each touched: entity events stamped with the group's correlation, written by Pip (or by
  // a turn, which may run as a Slack member). A sync's own writes share a reflex's correlation.
  const keys = [...groups.keys()];
  const [edge] = await tx
    .select({ seq: event.seq })
    .from(event)
    .where(lt(event.at, new Date(since.getTime() - SKEW_MS)))
    .orderBy(desc(event.seq))
    .limit(1);
  const changes = keys.length
    ? await tx
        .select({ key: event.correlationId, entityId: event.entityId, kind: event.kind })
        .from(event)
        .where(
          and(
            gt(event.seq, edge?.seq ?? 0),
            inArray(event.kind, Object.keys(HOW)),
            inArray(event.correlationId, keys),
            or(eq(event.actor, PRINCIPAL.jarvis), inArray(event.correlationId, allTurnIds)),
          ),
        )
        .orderBy(asc(event.seq))
        .limit(MAX_EVENTS)
    : [];
  for (const c of changes) {
    const g = c.key && c.entityId ? groups.get(c.key) : undefined;
    if (!g || !c.entityId) continue;
    const how = HOW[c.kind as keyof typeof HOW];
    const was = g.touchedBy.get(c.entityId);
    // Made beats changed; trashed beats both, since that's where it ended up.
    if (!was || how === "trashed" || (how === "made" && was === "changed"))
      g.touchedBy.set(c.entityId, how);
  }

  const ids = [
    ...new Set([
      ...[...groups.values()].flatMap((g) => [...g.touchedBy.keys()]),
      ...recordOf.values(),
    ]),
  ].slice(0, 500);
  const records = ids.length
    ? await tx
        .select({ id: entity.id, type: entity.type, title: entity.title })
        .from(entity)
        .where(inArray(entity.id, ids))
    : [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const titleOf = (actionId: string) => byId.get(recordOf.get(actionId) ?? "")?.title;

  const items = turns.flatMap((t) => itemIdsOf(t).map((id) => [id, t.id] as const));
  const taken = items.length
    ? await tx
        .select(ITEM)
        .from(heartbeatItem)
        .where(
          inArray(
            heartbeatItem.id,
            items.map(([id]) => id),
          ),
        )
    : [];
  const takenBy = new Map(items);
  for (const item of taken) groups.get(takenBy.get(item.id)!)?.setAside.push(item);
  const waiting =
    i.before || i.roleId
      ? []
      : await tx
          .select(ITEM)
          .from(heartbeatItem)
          .where(isNull(heartbeatItem.takenAt))
          .orderBy(asc(heartbeatItem.createdAt))
          .limit(50);

  const out: TimelineGroup[] = [...groups.values()].map(({ touchedBy, ...g }) => ({
    ...g,
    actions: g.actions.map((a) => ({ ...a, what: clip(titleOf(a.id)) ?? a.what })),
    touched: [...touchedBy]
      .flatMap(([id, how]) => {
        const r = byId.get(id);
        return r ? [{ id, type: r.type, title: r.title, how }] : [];
      })
      .slice(0, MAX_TOUCHED),
  }));
  // What each card did without asking, with its Undo; and each Undo you pressed, as its own card.
  const undos = await undosOf(tx, { since, groups: keys, edge: edge?.seq ?? 0 }, now);
  for (const g of out) g.undos = undos.filter((u) => u.groupId === g.id).map(shown);
  if (!i.roleId)
    out.push(...(await undidGroups(tx, edge?.seq ?? 0, since, i.before ? end : undefined)));
  out.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { groups: out, waiting, next: full && oldest ? oldest.toISOString() : null };
}

/**
 * What older turns did before the window, for the cards they're on because something of theirs
 * happened in it: the rest of their actions and approvals.
 */
async function addOlder(
  tx: Tx,
  older: TurnRow[],
  since: Date,
  actions: (typeof audit.$inferSelect)[],
  asks: (typeof approval.$inferSelect)[],
): Promise<void> {
  if (older.length === 0) return;
  const ids = older.map((t) => t.id);
  const from = new Date(Math.min(...older.map((t) => t.queuedAt.getTime())));
  actions.push(
    ...(await tx
      .select()
      .from(audit)
      .where(and(gte(audit.at, from), lt(audit.at, since), inArray(audit.correlationId, ids)))
      .limit(MAX_AUDIT)),
  );
  const have = new Set(asks.map((a) => a.id));
  const more = await tx
    .select()
    .from(approval)
    .where(or(inArray(approval.turnId, ids), inArray(approval.correlationId, ids)));
  asks.push(...more.filter((a) => !have.has(a.id)));
}
