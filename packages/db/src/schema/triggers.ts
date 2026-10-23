// Your triggers (Spec 6): when something of a kind you picked happens, Pip does what you wrote.
// Called owner_trigger, since TRIGGER is SQL's own word. Mirrors migrations/0051_owner_triggers.up.sql.
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const ownerTrigger = pgTable("owner_trigger", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  /** The event kind it waits for, from the short list Settings offers. */
  eventKind: text("event_kind").notNull(),
  /** Payload fields that must equal these values (case aside); {} matches every event. */
  filter: jsonb("filter").$type<Record<string, string>>().notNull().default({}),
  /** What to do, in your words. Never taken from outside content. */
  instructions: text("instructions").notNull(),
  /** The job its turns run for (Spec 3). */
  roleId: uuid("role_id"),
  /** The most turns it starts in a day. */
  perDay: integer("per_day").notNull().default(10),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});
