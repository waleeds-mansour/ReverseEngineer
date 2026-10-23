// Reading Pip's jobs (Spec 3) for Settings, Pip and What Pip did: each job with what's in it and
// the turns it spent today, and the proactive reflexes a job can take on. Called roles in code,
// since D82 already uses "job" for model tiers.
import { startOfLocalDay } from "@hearth/core";
import {
  type DbOrTx,
  entity,
  jarvisTurn,
  ROLE_CEILINGS,
  type RoleCeiling,
  role,
  roleReflex,
  roleRoutine,
  routine,
} from "@hearth/db";
import { type ActionContext, getSetting } from "@hearth/kernel";
import { and, asc, count, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";

export type RoleRow = typeof role.$inferSelect;

export interface RoleView {
  id: string;
  name: string;
  description: string;
  personaNote: string | null;
  riskCeiling: RoleCeiling;
  /** Its own turns a day, inside the global allowance; null when it has none of its own. */
  turnsPerDay: number | null;
  active: boolean;
  /** Turns it spent today (or has queued), its routines' included. */
  turnsToday: number;
  routines: { id: string; title: string }[];
  reflexes: { name: string; description: string }[];
}

/** A proactive reflex, and the job it's in, if any. */
export interface AttachableReflex {
  name: string;
  description: string;
  roleId: string | null;
}

export interface RoleList {
  roles: RoleView[];
  /** What Pip watches for on its own, which a job can take on. */
  reflexes: AttachableReflex[];
}

/** The proactive reflexes this process runs: only they can be in a job. */
export const proactiveReflexes = (ctx: Pick<ActionContext, "reflexes">) =>
  ctx.reflexes().filter((r) => r.mode === "proactive");

export async function findRole(db: DbOrTx, id: string): Promise<RoleRow | null> {
  const [r] = await db.select().from(role).where(eq(role.id, id));
  return r ?? null;
}

/** Another job already called this, whatever its case. */
export async function nameTaken(db: DbOrTx, name: string, except?: string): Promise<boolean> {
  const rows = await db
    .select({ id: role.id })
    .from(role)
    .where(sql`lower(${role.name}) = lower(${name})`);
  return rows.some((r) => r.id !== except);
}

/** Every job (or the one asked for), by name, with what's in it. */
export async function listRoles(
  ctx: Pick<ActionContext, "tx" | "now" | "reflexes">,
  only?: string,
): Promise<RoleList> {
  const db = ctx.tx;
  const rows = await db
    .select()
    .from(role)
    .where(only ? eq(role.id, only) : undefined)
    .orderBy(asc(role.name));
  const ids = rows.map((r) => r.id);
  const routines = ids.length
    ? await db
        .select({ roleId: roleRoutine.roleId, id: routine.entityId, title: entity.title })
        .from(roleRoutine)
        .innerJoin(routine, eq(routine.entityId, roleRoutine.routineId))
        .innerJoin(entity, eq(entity.id, routine.entityId))
        .where(and(inArray(roleRoutine.roleId, ids), isNull(entity.deletedAt)))
        .orderBy(asc(entity.title))
    : [];
  const attached = await db.select().from(roleReflex);
  const reflexes = proactiveReflexes(ctx);
  const rules = await getSetting(db, "owner.dayRules");
  const spent = ids.length
    ? await db
        .select({ roleId: jarvisTurn.roleId, n: count() })
        .from(jarvisTurn)
        .where(
          and(
            isNotNull(jarvisTurn.roleId),
            inArray(jarvisTurn.roleId, ids),
            inArray(jarvisTurn.status, ["queued", "running", "done", "failed"]),
            gte(jarvisTurn.queuedAt, startOfLocalDay(ctx.now, rules.timeZone)),
          ),
        )
        .groupBy(jarvisTurn.roleId)
    : [];
  const roleOf = new Map(attached.map((a) => [a.reflexName, a.roleId]));
  return {
    roles: rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      personaNote: r.personaNote,
      riskCeiling: r.riskCeiling,
      turnsPerDay: r.turnsPerDay,
      active: r.active,
      turnsToday: spent.find((s) => s.roleId === r.id)?.n ?? 0,
      routines: routines.filter((x) => x.roleId === r.id).map(({ id, title }) => ({ id, title })),
      reflexes: attached
        .filter((a) => a.roleId === r.id)
        .map((a) => ({
          name: a.reflexName,
          description: reflexes.find((x) => x.name === a.reflexName)?.description ?? a.reflexName,
        })),
    })),
    reflexes: reflexes.map((x) => ({
      name: x.name,
      description: x.description,
      roleId: roleOf.get(x.name) ?? null,
    })),
  };
}

const reach = (c: RoleCeiling) => ROLE_CEILINGS.indexOf(c);

/**
 * Whether a change lets a job do more than it could: a higher ceiling, turning it back on, or a
 * bigger allowance (or none of its own). Only you can loosen a job; Pip can only tighten one.
 */
export function loosens(
  was: Pick<RoleRow, "riskCeiling" | "active" | "turnsPerDay">,
  now: Pick<RoleRow, "riskCeiling" | "active" | "turnsPerDay">,
): boolean {
  if (reach(now.riskCeiling) > reach(was.riskCeiling)) return true;
  if (now.active && !was.active) return true;
  if (was.turnsPerDay === null) return false;
  return now.turnsPerDay === null || now.turnsPerDay > was.turnsPerDay;
}
