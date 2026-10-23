// Which Claude model does which of Pip's jobs (D82). Three tiers: Haiku for quick decisions and
// short rewrites, Sonnet for conversations and most work, Opus for work Pip does on its own,
// anything about code, and taking over a turn Sonnet couldn't finish. Every job and its tier is in JOBS below. The
// owner can point a tier at another model, or move a job to another tier, from .env.
import type { TurnLane, TurnTrigger } from "@hearth/db";

export type Tier = "haiku" | "sonnet" | "opus";
export type Effort = "low" | "medium" | "high";

/** The model behind each tier, unless .env says otherwise (HEARTH_MODEL_HAIKU and so on). */
export const TIER_MODELS: Record<Tier, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** Cheapest first: a turn that couldn't finish goes one step up (escalate). */
const LADDER: Tier[] = ["haiku", "sonnet", "opus"];

/**
 * Each job's tier, and how hard the model thinks (effort; left out, the model's own default).
 * Move a job with HEARTH_JARVIS_JOBS, e.g. "brief=opus,watch=sonnet".
 */
export const JOBS = {
  /** You wrote to Pip, or @mentioned it, with a quick ask. */
  "chat.quick": { tier: "sonnet", effort: "low" },
  /** A long or open-ended ask (plan, draft, research...: routeLane). */
  "chat.deep": { tier: "sonnet", effort: "high" },
  /** A task you assigned to Pip: it works it alone, start to finish. */
  "task.work": { tier: "opus" },
  /**
   * Anything about code, always Opus (the owner, 2026-10-23): an ask in chat or an @mention that
   * looks like code (looksLikeCode, no model call), a task about code (its work and its thread),
   * and turns GitHub started. Spec 2's code runs in a worktree will use it too, when they're built.
   */
  code: { tier: "opus" },
  /** You commented on a task Pip is working. */
  "task.thread": { tier: "sonnet", effort: "medium" },
  /** You answered one of Pip's cards: it carries on. */
  approval: { tier: "sonnet", effort: "low" },
  /** Something Pip watches for happened: does it need anything? */
  watch: { tier: "haiku" },
  /** The heartbeat, with only Slack asks and notes to sort: tasks, notes or nothing. */
  "heartbeat.triage": { tier: "haiku" },
  /** The heartbeat, with emails to draft replies to in your voice. */
  "heartbeat.drafts": { tier: "sonnet", effort: "medium" },
  /** 7:45 a.m.: replies drafted in your voice. */
  reply_drafts: { tier: "sonnet", effort: "medium" },
  /** 9:30 a.m.: follow-ups drafted for questions nobody answered. */
  follow_ups: { tier: "sonnet", effort: "medium" },
  /** 8:15 a.m.: the morning brief. */
  brief: { tier: "sonnet", effort: "medium" },
  /**
   * 7:30 p.m.: the journal, a short record of the day from Nook's own facts. The nightly memory is
   * built from it, and it runs once a day, so Sonnet costs next to nothing more than Haiku.
   */
  journal: { tier: "sonnet", effort: "medium" },
  /** Nightly: what's worth remembering. */
  memory: { tier: "sonnet", effort: "medium" },
  /** 6 a.m.: prep packets for the next meetings. */
  prep: { tier: "sonnet", effort: "medium" },
  /** An event that needs a look: today, a meeting that ended (its summary and tasks). */
  reflex: { tier: "sonnet", effort: "medium" },
  /** One of your own routines. */
  routine: { tier: "sonnet", effort: "high" },
  /** A spoken command from the desktop app: rewrite or write the text at your cursor. */
  voice: { tier: "haiku", effort: "low" },
  /** Someone in your Slack wrote to Pip's bot: Pip answers them. */
  slack_member: { tier: "sonnet", effort: "low" },
  /** `hearth doctor`'s check that Claude answers at all. */
  probe: { tier: "haiku", effort: "low" },
} as const satisfies Record<string, { tier: Tier; effort?: Effort }>;

export type Job = keyof typeof JOBS;

export interface ModelChoice {
  job: Job;
  tier: Tier;
  /** The model the tier runs. */
  model: string;
  effort?: Effort;
  /** A lower tier couldn't finish this turn, and this one took over. */
  escalated?: boolean;
}

type Env = Record<string, string | undefined>;

/** What a job needs to know about its turn. */
export interface TurnLike {
  trigger: TurnTrigger;
  lane: TurnLane;
  context: Record<string, unknown>;
}

/** Built-in routines whose name is their job; any other routine is one of yours. */
const ROUTINE_JOBS = new Set<Job>([
  "reply_drafts",
  "follow_ups",
  "brief",
  "journal",
  "memory",
  "prep",
]);

/** Turns that run as the code job when what started them marked them as about code. */
const CODE_TRIGGERS = new Set<TurnTrigger>(["chat", "mention", "assignment", "reflex", "watch"]);

/** The job a turn does, from what started it. */
export function jobOf(turn: TurnLike): Job {
  if (turn.context.code === true && CODE_TRIGGERS.has(turn.trigger)) return "code";
  switch (turn.trigger) {
    case "chat":
    case "mention":
      return turn.lane === "deep" ? "chat.deep" : "chat.quick";
    case "assignment":
      return turn.lane === "deep" ? "task.work" : "task.thread";
    case "approval":
    case "watch":
    case "reflex":
    case "slack_member":
      return turn.trigger;
    case "voice_command":
      return "voice";
    case "routine": {
      const { routine, source, drafts } = turn.context;
      // Your routines carry your title, which could be any word, so they go by the reflex that
      // ran them. Every timed turn has a schedule, built-in ones too.
      if (source === "routine.due") return "routine";
      if (routine === "heartbeat") return drafts === true ? "heartbeat.drafts" : "heartbeat.triage";
      return ROUTINE_JOBS.has(routine as Job) ? (routine as Job) : "routine";
    }
  }
}

/** The model a tier runs, with the owner's .env override. */
export function tierModel(tier: Tier, env: Env = process.env): string {
  return env[`HEARTH_MODEL_${tier.toUpperCase()}`]?.trim() || TIER_MODELS[tier];
}

/** Jobs the owner moved to another tier: "brief=opus, watch=sonnet". Unknown names are skipped. */
export function movedJobs(env: Env = process.env): Partial<Record<Job, Tier>> {
  const out: Partial<Record<Job, Tier>> = {};
  for (const pair of (env.HEARTH_JARVIS_JOBS ?? "").split(",")) {
    const [job, tier] = pair.split("=").map((s) => s.trim().toLowerCase());
    if (job && job in JOBS && LADDER.includes(tier as Tier)) out[job as Job] = tier as Tier;
  }
  return out;
}

function choose(job: Job, tier: Tier, env: Env): ModelChoice {
  const { effort } = JOBS[job] as { effort?: Effort };
  return { job, tier, model: tierModel(tier, env), ...(effort ? { effort } : {}) };
}

/** The model for a job, after the owner's overrides. */
export function modelForJob(job: Job, env: Env = process.env): ModelChoice {
  return choose(job, movedJobs(env)[job] ?? JOBS[job].tier, env);
}

/** The model for a turn. */
export function modelFor(turn: TurnLike, env: Env = process.env): ModelChoice {
  return modelForJob(jobOf(turn), env);
}

/** The tiers' models and the jobs moved off their tier, in a line for the log. */
export function describeTiers(env: Env = process.env): string {
  const tiers = LADDER.map((t) => `${t} ${tierModel(t, env)}`).join(", ");
  const moved = Object.entries(movedJobs(env)).map(([job, tier]) => `${job} on ${tier}`);
  return moved.length ? `${tiers}; moved: ${moved.join(", ")}` : tiers;
}

/** One tier up, for a turn that couldn't finish: once per turn, never past Opus. */
export function escalate(choice: ModelChoice, env: Env = process.env): ModelChoice | null {
  if (choice.escalated) return null;
  const up = LADDER[LADDER.indexOf(choice.tier) + 1];
  return up ? { ...choose(choice.job, up, env), escalated: true } : null;
}
