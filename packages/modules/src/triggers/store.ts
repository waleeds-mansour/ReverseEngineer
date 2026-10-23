// Reading your triggers (Spec 6) for Settings, Pip and the reflex that fires them: each with its
// job's name and how many turns it started today, and the kinds of event one can wait for.
import { isUuid, startOfLocalDay } from "@hearth/core";
import { type DbOrTx, jarvisTurn, ownerTrigger, role } from "@hearth/db";
import { getSetting, type HearthEvent } from "@hearth/kernel";
import { and, asc, count, eq, gte, inArray, max, sql } from "drizzle-orm";
import { TRIGGER_KINDS, type TriggerField } from "./kinds.ts";

export type TriggerRow = typeof ownerTrigger.$inferSelect;

export interface TriggerView {
  id: string;
  name: string;
  /** The event kind it waits for, and that in words. */
  on: string;
  onLabel: string;
  filter: Record<string, string>;
  instructions: string;
  roleId: string | null;
  /** The job's name, while it has one. */
  job: string | null;
  perDay: number;
  /** Turns it started today (or has queued). */
  firedToday: number;
  lastFiredAt: Date | null;
  active: boolean;
}

/** A kind of event a trigger can wait for, as Settings offers it. */
export interface TriggerKindView {
  kind: string;
  label: string;
  fields: TriggerField[];
}

export interface TriggerList {
  triggers: TriggerView[];
  kinds: TriggerKindView[];
}

/** Turns that count against a trigger's day: started, or still to start. */
const SPENT = ["queued", "running", "done", "failed"] as const;
const triggerIdOf = sql<string>`${jarvisTurn.context} ->> 'triggerId'`;

export async function findTrigger(db: DbOrTx, id: string): Promise<TriggerRow | null> {
  const [r] = await db.select().from(ownerTrigger).where(eq(ownerTrigger.id, id));
  return r ?? null;
}

/** Another trigger already called this, whatever its case. */
export async function nameTaken(db: DbOrTx, name: string, except?: string): Promise<boolean> {
  const rows = await db
    .select({ id: ownerTrigger.id })
    .from(ownerTrigger)
    .where(sql`lower(${ownerTrigger.name}) = lower(${name})`);
  return rows.some((r) => r.id !== except);
}

/** Turns each of these triggers started today, by id. */
async function firedToday(db: DbOrTx, now: Date, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rules = await getSetting(db, "owner.dayRules");
  const rows = await db
    .select({ id: triggerIdOf, n: count() })
    .from(jarvisTurn)
    .where(
      and(
        eq(jarvisTurn.trigger, "trigger"),
        inArray(triggerIdOf, ids),
        inArray(jarvisTurn.status, [...SPENT]),
        gte(jarvisTurn.queuedAt, startOfLocalDay(now, rules.timeZone)),
      ),
    )
    .groupBy(triggerIdOf);
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** Turns this trigger started today: its cap counts these. */
export async function firedTodayOf(db: DbOrTx, now: Date, id: string): Promise<number> {
  return (await firedToday(db, now, [id])).get(id) ?? 0;
}

/** Every trigger (or the one asked for), by name, with its job and its day so far. */
export async function listTriggers(
  ctx: { tx: DbOrTx; now: Date },
  only?: string,
): Promise<TriggerList> {
  const db = ctx.tx;
  const rows = await db
    .select({ t: ownerTrigger, job: role.name })
    .from(ownerTrigger)
    .leftJoin(role, eq(role.id, ownerTrigger.roleId))
    .where(only ? eq(ownerTrigger.id, only) : undefined)
    .orderBy(asc(ownerTrigger.name));
  const ids = rows.map((r) => r.t.id);
  const today = await firedToday(db, ctx.now, ids);
  const last = ids.length
    ? await db
        .select({ id: triggerIdOf, at: max(jarvisTurn.queuedAt) })
        .from(jarvisTurn)
        .where(
          and(
            eq(jarvisTurn.trigger, "trigger"),
            inArray(triggerIdOf, ids),
            inArray(jarvisTurn.status, [...SPENT]),
          ),
        )
        .groupBy(triggerIdOf)
    : [];
  return {
    triggers: rows.map(({ t, job }) => ({
      id: t.id,
      name: t.name,
      on: t.eventKind,
      onLabel: TRIGGER_KINDS[t.eventKind]?.label ?? t.eventKind,
      filter: t.filter,
      instructions: t.instructions,
      roleId: t.roleId,
      job,
      perDay: t.perDay,
      firedToday: today.get(t.id) ?? 0,
      lastFiredAt: last.find((l) => l.id === t.id)?.at ?? null,
      active: t.active,
    })),
    kinds: Object.entries(TRIGGER_KINDS).map(([kind, k]) => ({
      kind,
      label: k.label,
      fields: k.fields,
    })),
  };
}

/** The active triggers waiting for this kind of event, with whether their job is on. */
export function armedFor(db: DbOrTx, kind: string) {
  return db
    .select({ t: ownerTrigger, jobActive: role.active })
    .from(ownerTrigger)
    .leftJoin(role, eq(role.id, ownerTrigger.roleId))
    .where(and(eq(ownerTrigger.eventKind, kind), eq(ownerTrigger.active, true)))
    .orderBy(asc(ownerTrigger.name));
}

/**
 * Whether Pip's own work led to this event, so a trigger that fired on it could fire on its own
 * turn's doings, and loop: Pip did it, or it came of a call in one of Pip's turns (whose
 * correlation id is the turn's), like a sync that turn started or an approval of what it asked.
 */
export async function causedByPip(
  db: DbOrTx,
  event: Pick<HearthEvent, "actor" | "correlationId">,
): Promise<boolean> {
  if (event.actor === "jarvis") return true;
  if (!event.correlationId || !isUuid(event.correlationId)) return false;
  const [turn] = await db
    .select({ id: jarvisTurn.id })
    .from(jarvisTurn)
    .where(eq(jarvisTurn.id, event.correlationId));
  return Boolean(turn);
}

type Loosenable = Pick<TriggerRow, "active" | "perDay" | "filter" | "roleId">;

/**
 * Whether a change lets a trigger do more than it could: back on, more turns a day, a filter that
 * lets more events through (a field dropped or changed), or out of its job (or into another).
 * Only you can loosen a trigger; Pip can tighten one, or pause or remove it.
 */
export function loosens(was: Loosenable, now: Loosenable): boolean {
  if (now.active && !was.active) return true;
  if (now.perDay > was.perDay) return true;
  for (const [key, value] of Object.entries(was.filter))
    if (now.filter[key]?.trim().toLowerCase() !== value.trim().toLowerCase()) return true;
  return was.roleId !== null && now.roleId !== was.roleId;
}
