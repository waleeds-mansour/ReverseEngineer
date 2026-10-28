// Pip's questions with choices (D85). Mirrors migrations/0059_questions.up.sql.
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

type Origin = "owner" | "agent" | "untrusted" | "system";

export type QuestionStatus = "open" | "answered" | "expired";

/** The owner's answer: a choice by its place in `choices` (from 0), their own words, or both. */
export interface QuestionAnswer {
  choice?: number;
  text?: string;
}

export const question = pgTable("question", {
  id: uuid("id").primaryKey(),
  conversationId: uuid("conversation_id").notNull(),
  turnId: uuid("turn_id").notNull(),
  question: text("question").notNull(),
  choices: jsonb("choices").$type<string[]>().notNull(),
  why: text("why"),
  /** The asking turn's origin: an untrusted one's card and picked-up work say so (D58). */
  origin: text("origin").$type<Origin>().notNull(),
  status: text("status").$type<QuestionStatus>().notNull().default("open"),
  answer: jsonb("answer").$type<QuestionAnswer>(),
  answeredAt: ts("answered_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at").notNull(),
});
