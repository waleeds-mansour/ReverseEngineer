// The daily turn budget for proactive work. Model turns share the owner's Max rate limit with
// their own Claude use, so Jarvis's initiative is rationed; answering the owner never is. A job
// can ration its own turns further, inside that (Spec 3).
import { startOfLocalDay } from "@hearth/core";
import { type DbOrTx, jarvisTurn } from "@hearth/db";
import { getSetting } from "@hearth/kernel";
import { and, count, eq, gte, inArray, type SQL } from "drizzle-orm";

export type Gate = { open: true } | { open: false; reason: "paused" | "budget" };

/** A job's own allowance, if it has one. */
export interface RoleBudget {
  id: string;
  turnsPerDay: number | null;
}

/** Turns spent today (or still to spend) that match `which`. */
async function turnsToday(db: DbOrTx, now: Date, which: SQL): Promise<number> {
  const rules = await getSetting(db, "owner.dayRules");
  const [row] = await db
    .select({ n: count() })
    .from(jarvisTurn)
    .where(
      and(
        which,
        inArray(jarvisTurn.status, ["queued", "running", "done", "failed"]),
        gte(jarvisTurn.queuedAt, startOfLocalDay(now, rules.timeZone)),
      ),
    );
  return row?.n ?? 0;
}

export function proactiveTurnsToday(db: DbOrTx, now: Date): Promise<number> {
  return turnsToday(db, now, eq(jarvisTurn.mode, "proactive"));
}

/** Every turn a job spent today, its routines' included. */
export function roleTurnsToday(db: DbOrTx, now: Date, roleId: string): Promise<number> {
  return turnsToday(db, now, eq(jarvisTurn.roleId, roleId));
}

/** Whether a proactive turn may be spent now. */
export async function proactiveGate(db: DbOrTx, now: Date): Promise<Gate> {
  if (await getSetting(db, "jarvis.paused")) return { open: false, reason: "paused" };
  const limit = await getSetting(db, "jarvis.proactiveTurnsPerDay");
  if ((await proactiveTurnsToday(db, now)) >= limit) return { open: false, reason: "budget" };
  return { open: true };
}

/**
 * Whether a turn may be spent now. Proactive work passes the pause switch and the global
 * allowance; a job with an allowance of its own counts its turns against that too, whatever their
 * mode, so a busy job can't use up what the others need. A job only narrows: its allowance never
 * lets a turn past the global one.
 */
export async function turnGate(
  db: DbOrTx,
  now: Date,
  mode: "reactive" | "proactive",
  role: RoleBudget | null,
): Promise<Gate> {
  if (mode === "proactive") {
    const gate = await proactiveGate(db, now);
    if (!gate.open) return gate;
  }
  if (role?.turnsPerDay != null && (await roleTurnsToday(db, now, role.id)) >= role.turnsPerDay)
    return { open: false, reason: "budget" };
  return { open: true };
}
