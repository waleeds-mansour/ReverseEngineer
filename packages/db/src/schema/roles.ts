// Pip's jobs (Spec 3), called roles in code: D82 already uses "job" for model tiers.
// Mirrors migrations/0050_roles.up.sql.
import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** The most a job's turns may do, lowest first. A call above it is held for your brief. */
export const ROLE_CEILINGS = ["read", "internal", "self_external", "outward"] as const;
export type RoleCeiling = (typeof ROLE_CEILINGS)[number];

export const role = pgTable("role", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  /** A few lines added to its turns' prompt, in your words. */
  personaNote: text("persona_note"),
  riskCeiling: text("risk_ceiling").$type<RoleCeiling>().notNull().default("read"),
  /** Its own turns a day, inside the global allowance; null shares the global one alone. */
  turnsPerDay: integer("turns_per_day"),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Which of your routines belong to a job: one job each at most. */
export const roleRoutine = pgTable("role_routine", {
  routineId: uuid("routine_id").primaryKey(),
  roleId: uuid("role_id").notNull(),
});

/** Which of Pip's proactive reflexes belong to a job, by name: one job each at most. */
export const roleReflex = pgTable("role_reflex", {
  reflexName: text("reflex_name").primaryKey(),
  roleId: uuid("role_id").notNull(),
});
