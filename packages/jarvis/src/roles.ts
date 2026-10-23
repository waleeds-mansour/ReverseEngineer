// Pip's jobs (Spec 3), as the engine and the runner read them: which job each proactive reflex
// belongs to, a job's own allowance, and what its turns' prompt says about it. A job only narrows
// what Pip does; the kernel holds its ceiling (holdsFor), not this.
import { type DbOrTx, type RoleCeiling, role, roleReflex } from "@hearth/db";
import { eq } from "drizzle-orm";
import type { RoleBudget } from "./budget.ts";

export interface ReflexRole extends RoleBudget {
  active: boolean;
}

/** The job each attached reflex belongs to, by reflex name. */
export async function reflexRoles(db: DbOrTx): Promise<Map<string, ReflexRole>> {
  const rows = await db
    .select({
      reflex: roleReflex.reflexName,
      id: role.id,
      active: role.active,
      turnsPerDay: role.turnsPerDay,
    })
    .from(roleReflex)
    .innerJoin(role, eq(role.id, roleReflex.roleId));
  return new Map(rows.map(({ reflex, ...r }) => [reflex, r]));
}

/** A job's own allowance, or null when it's gone. */
export async function roleBudget(db: DbOrTx, id: string): Promise<RoleBudget | null> {
  const [r] = await db
    .select({ id: role.id, turnsPerDay: role.turnsPerDay })
    .from(role)
    .where(eq(role.id, id));
  return r ?? null;
}

export interface PromptRole {
  name: string;
  ceiling: RoleCeiling;
  personaNote: string | null;
}

/** What a job's turn is told about the job, or null when it has none (or it's gone). */
export async function promptRole(db: DbOrTx, id: string | null): Promise<PromptRole | null> {
  if (!id) return null;
  const [r] = await db
    .select({ name: role.name, ceiling: role.riskCeiling, personaNote: role.personaNote })
    .from(role)
    .where(eq(role.id, id));
  return r ?? null;
}
