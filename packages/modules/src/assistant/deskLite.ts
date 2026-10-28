// Pip's desk, cut down for the desktop app's dock (apps/server/src/routes/desktop.ts): whether Pip
// is resting, thinking about something you asked or working on something else, said in a few
// words; how many things wait for your yes; and Nook's own health, as system.status judges it.
// The desktop app's token reads it on its notification feed, so it carries nobody's words: no
// prompt, reply, mail or message, only counts, states and the short label the dock shows ("your
// morning brief"). It reads as jarvis.desk does (desk.ts), Pip's first running turn.
import { PRINCIPAL } from "@hearth/core";
import { approval, type DbOrTx, event, jarvisTurn, ownerTrigger, setting } from "@hearth/db";
import { getSetting } from "@hearth/kernel";
import { and, asc, count, eq, like, sql } from "drizzle-orm";
import type { HealthRecord } from "../system/index.ts";
import { EXTERNAL_COMPONENTS, judgeHealth } from "../system/staleness.ts";

/** A component as the dock shows it: unknown until it has reported. */
export type LiteHealth = "ok" | "degraded" | "failing" | "unknown";

export interface DeskLite {
  pip: {
    /** Thinking is a turn you asked for, whose answer you're waiting on; working is any other. */
    state: "idle" | "thinking" | "working";
    /** What it's on, to follow "Working on": "your morning brief". Null while it rests. */
    label: string | null;
    /** Its own work is paused (jarvis.pause). */
    paused: boolean;
  };
  /** Approvals waiting for your yes or no. */
  approvals: number;
  health: {
    worker: LiteHealth;
    jarvis: LiteHealth;
    /** The worst of the syncs (sync.google, sync.slack and the rest). */
    sync: LiteHealth;
    /** The worst of everything else Nook watches: the disk, backups, schedules, Chrome's link. */
    other: LiteHealth;
  };
}

/** The events after which the dock's status may read differently. */
export const DESK_LITE_KINDS = [
  "jarvis.turn_started",
  "jarvis.turn_finished",
  "jarvis.paused_changed",
  "approval.requested",
  "approval.resolved",
  "system.health_changed",
];

/** The turns you start yourself: Pip thinks about them while you wait. */
const ASKED = new Set(["chat", "voice_command"]);

/**
 * The routines Nook comes with, by the name their turns carry, as "Working on" ends. Maps, so a
 * name like "constructor" finds nothing rather than something every object has.
 */
const ROUTINE = new Map<string, string>([
  ["brief", "your morning brief"],
  ["journal", "your evening journal"],
  ["calendar.prep", "meeting prep"],
  ["calendar.time_blocks", "time for your tasks"],
  ["reply_drafts", "reply drafts"],
  ["follow_ups", "follow-ups"],
  ["memory", "what it remembers"],
  ["people.personas", "notes on people"],
  ["jarvis.heartbeat", "its heartbeat"],
]);

const BY_TRIGGER = new Map<string, string>([
  ["chat", "what you asked"],
  ["voice_command", "what you asked"],
  ["mention", "an @mention"],
  ["assignment", "a task you gave it"],
  ["approval", "what you approved"],
  ["watch", "a watch that matched"],
  ["reflex", "something it noticed"],
  ["slack_member", "a message in Slack"],
]);

/** The longest a trigger's name runs in the label. */
const NAME_MAX = 40;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * What a turn is about in a few words, never its prompt: the routine by its name, a trigger by
 * `ownName` when it is the owner's own words for it (ownTriggerName), otherwise what set it off.
 * The name a trigger turn carries in its context is never used: Pip may have written it.
 */
export function deskLabel(
  t: { trigger: string; context: Record<string, unknown> | null },
  ownName: string | null = null,
): string {
  const c = t.context ?? {};
  if (t.trigger === "chat" && c.via === "slack") return "what you asked in Slack";
  if (t.trigger === "routine") return ROUTINE.get(str(c.source) ?? "") ?? "a routine";
  if (t.trigger === "trigger") {
    const name = str(ownName);
    if (!name) return "one of your triggers";
    const short = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
    return `your trigger “${short}”`;
  }
  return BY_TRIGGER.get(t.trigger) ?? "something";
}

/** Each trigger's verdict, by its id, kept while its name and when it last changed stay the same. */
const verdicts = new Map<string, { as: string; own: boolean }>();

/**
 * The trigger's name, if only the owner has ever made or changed it: Pip can make and rename
 * triggers too (trigger.create, trigger.update), and its words aren't the owner's. Who did is in
 * the event log, which has no index to find a trigger's changes by, so the verdict is kept until
 * the trigger changes again rather than read on every status.
 */
export async function ownTriggerName(db: DbOrTx, id: unknown): Promise<string | null> {
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db
    .select({ name: ownerTrigger.name, updatedAt: ownerTrigger.updatedAt })
    .from(ownerTrigger)
    .where(eq(ownerTrigger.id, id));
  if (!row) return null;
  const as = `${row.updatedAt.getTime()} ${row.name}`;
  let verdict = verdicts.get(id);
  if (verdict?.as !== as) {
    const actors = await db
      .selectDistinct({ actor: event.actor })
      .from(event)
      .where(and(eq(event.kind, "trigger.changed"), sql`${event.payload}->>'id' = ${id}`));
    verdict = { as, own: actors.length > 0 && actors.every((a) => a.actor === PRINCIPAL.owner) };
    if (verdicts.size >= 200) verdicts.clear();
    verdicts.set(id, verdict);
  }
  return verdict.own ? row.name : null;
}

const RANK: Record<LiteHealth, number> = { unknown: 0, ok: 1, degraded: 2, failing: 3 };
const worst = (all: LiteHealth[]): LiteHealth =>
  all.reduce<LiteHealth>((a, b) => (RANK[b] > RANK[a] ? b : a), "unknown");

/** Each component as system.status judges it: one that stopped reporting is failing. */
export function liteHealth(
  records: { name: string; record: HealthRecord }[],
  now: Date,
): DeskLite["health"] {
  const judged = records
    .filter((r) => !EXTERNAL_COMPONENTS.has(r.name))
    .map((r) => ({ name: r.name, status: judgeHealth(r.name, r.record, now).status }));
  const of = (pick: (name: string) => boolean) =>
    worst(judged.filter((j) => pick(j.name)).map((j) => j.status));
  return {
    worker: of((n) => n === "worker"),
    jarvis: of((n) => n === "jarvis"),
    sync: of((n) => n.startsWith("sync.")),
    other: of((n) => n !== "worker" && n !== "jarvis" && !n.startsWith("sync.")),
  };
}

const ownName = (db: DbOrTx, t: { trigger: string; context: Record<string, unknown> | null }) =>
  t.trigger === "trigger" ? ownTriggerName(db, t.context?.triggerId) : null;

export async function deskLite(db: DbOrTx, now: Date): Promise<DeskLite> {
  const [turn] = await db
    .select({ trigger: jarvisTurn.trigger, context: jarvisTurn.context })
    .from(jarvisTurn)
    .where(eq(jarvisTurn.status, "running"))
    .orderBy(asc(jarvisTurn.startedAt))
    .limit(1);
  const [waiting] = await db
    .select({ n: count() })
    .from(approval)
    .where(eq(approval.status, "pending"));
  const health = await db
    .select({ key: setting.key, value: setting.value })
    .from(setting)
    .where(like(setting.key, "health.%"));
  return {
    pip: {
      state: !turn ? "idle" : ASKED.has(turn.trigger) ? "thinking" : "working",
      label: turn ? deskLabel(turn, await ownName(db, turn)) : null,
      paused: (await getSetting(db, "jarvis.paused")) === true,
    },
    approvals: Number(waiting?.n ?? 0),
    health: liteHealth(
      health.map((h) => ({
        name: h.key.slice("health.".length),
        record: h.value as HealthRecord,
      })),
      now,
    ),
  };
}
