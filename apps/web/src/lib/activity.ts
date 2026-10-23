// What Pip did, one card per thing that set it off (activity.timeline): the shapes it comes in,
// and how a card says what started it, what it ran and how each went, in plain words.

import { isSlackTurn } from "./slack.ts";
import type { Tone } from "./status.ts";
import { toolSentence } from "./toolNames.ts";

export interface TimelineTurn {
  id: string;
  trigger: string;
  mode: string;
  lane: string;
  status: string;
  outcome: string | null;
  reply: string | null;
  error: string | null;
  skipReason: string | null;
  /** What you asked, for a turn you started by typing or speaking. */
  asked: string | null;
  via: string | null;
  /** The routine or reflex that queued it ("brief", "jarvis.heartbeat"). */
  source: string | null;
  /** The job (role) it ran for (Spec 3): its name is in role.list. */
  roleId: string | null;
  /** The name of your trigger that set it off (Spec 6). */
  triggerName: string | null;
  readOutside: boolean;
  conversationId: string | null;
  subjectId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

export interface TimelineAction {
  id: string;
  at: string;
  action: string;
  risk: string;
  outcome: "ok" | "error" | "pending_approval" | "denied";
  error: string | null;
  durationMs: number;
  approvalId: string | null;
  what: string | null;
}

export interface TimelineApproval {
  id: string;
  action: string;
  summary: string;
  status: string;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface TimelineTouched {
  id: string;
  type: string;
  title: string;
  how: "made" | "changed" | "trashed";
}

/** Something a reflex set aside for the heartbeat. */
export interface SetAside {
  id: string;
  text: string;
  aboutId: string | null;
  createdAt: string;
  takenAt: string | null;
}

export interface TimelineGroup {
  /** The correlation id: the turn's id for a turn. */
  id: string;
  /** When the last thing in it happened. */
  at: string;
  turn: TimelineTurn | null;
  actions: TimelineAction[];
  approvals: TimelineApproval[];
  touched: TimelineTouched[];
  setAside: SetAside[];
}

export interface Timeline {
  groups: TimelineGroup[];
  waiting: SetAside[];
  next: string | null;
}

const TRIGGER: Record<string, string> = {
  chat: "You asked",
  voice_command: "You said",
  mention: "@mentioned",
  assignment: "Assigned a task",
  approval: "After your answer",
  watch: "A watch matched",
  routine: "Routine",
  reflex: "Noticed something",
  slack_member: "Someone in Slack",
  trigger: "Your trigger",
};

/** The routines Hearth comes with, by the name their turns carry. */
const ROUTINE: Record<string, string> = {
  brief: "Morning brief",
  journal: "Evening journal",
  "calendar.prep": "Meeting prep",
  "calendar.time_blocks": "Time for your tasks",
  reply_drafts: "Reply drafts",
  follow_ups: "Follow-ups",
  memory: "Tidying what it remembers",
  "jarvis.heartbeat": "Heartbeat",
};

/**
 * What set a card off, in words: "You asked", "Heartbeat", "Noticed something", or your trigger
 * by name: "Your trigger: Acme emails".
 */
export function startedBy(g: Pick<TimelineGroup, "turn">): string {
  const t = g.turn;
  if (!t) return "Noticed something";
  if (t.trigger === "chat" && t.via === "slack") return "You asked in Slack";
  if (t.trigger === "routine") return (t.source && ROUTINE[t.source]) ?? "Routine";
  if (t.trigger === "trigger" && t.triggerName) return `Your trigger: ${t.triggerName}`;
  return TRIGGER[t.trigger] ?? t.trigger;
}

/** Whether Slack started it: a member's message, or your own DM with Pip there (D62). */
export const fromSlack = (g: Pick<TimelineGroup, "turn">) =>
  g.turn !== null && isSlackTurn({ trigger: g.turn.trigger, context: { via: g.turn.via } });

const OUTCOME: Record<TimelineAction["outcome"], { word: string; tone: Tone }> = {
  ok: { word: "Done", tone: "positive" },
  error: { word: "Failed", tone: "danger" },
  pending_approval: { word: "Asked you", tone: "warning" },
  denied: { word: "Not allowed", tone: "danger" },
};

/** How an action went, in a word, and its badge's tone. */
export const outcomeOf = (o: TimelineAction["outcome"]) => OUTCOME[o] ?? OUTCOME.error;

/**
 * Whether a refusal was a hold: background work while read-only (Spec 5), or past a job's ceiling
 * (Spec 3). The kernel ends every such reason the same way (policy.ts).
 */
export const isHeld = (error: string | null) =>
  Boolean(error?.endsWith("so this was held for your brief."));

const HELD = { word: "Held for your brief", tone: "warning" as Tone };

/** How a run of actions went, a hold said as one rather than as not allowed. */
export const runOutcome = (r: Pick<ActionRun, "outcome" | "error">) =>
  r.outcome === "denied" && isHeld(r.error) ? HELD : outcomeOf(r.outcome);

const RISK: Record<string, string> = {
  read: "Read only",
  internal: "In Nook",
  self_external: "Your accounts",
  outward: "Others see it",
  destructive: "Hard to undo",
  secret: "Sign-ins",
};

/** How far an action reaches, in a word or two. */
export const riskOf = (risk: string) => RISK[risk] ?? risk;

/** Actions in a row that are the same call ending the same way: "Read an email ×12". */
export interface ActionRun {
  key: string;
  action: string;
  risk: string;
  outcome: TimelineAction["outcome"];
  count: number;
  /** The line: "Made a task", "Asked before sending an email", "Sending an email failed". */
  said: string;
  /** What each was about, the first few. */
  whats: string[];
  error: string | null;
}

/**
 * A card's actions, oldest first, with repeats run together. One that waited for your yes is left
 * out when the card lists its approval, which says it better.
 */
export function runsOf(g: Pick<TimelineGroup, "actions" | "approvals">): ActionRun[] {
  const asked = new Set(g.approvals.map((a) => a.id));
  const runs: ActionRun[] = [];
  for (const a of g.actions) {
    if (a.outcome === "pending_approval" && a.approvalId && asked.has(a.approvalId)) continue;
    const last = runs.at(-1);
    if (last && last.action === a.action && last.outcome === a.outcome) {
      last.count++;
      if (a.what && last.whats.length < 3 && !last.whats.includes(a.what)) last.whats.push(a.what);
      last.error ??= a.error;
      continue;
    }
    const status =
      a.outcome === "pending_approval"
        ? "pending_approval"
        : a.outcome === "denied"
          ? "refused"
          : "done";
    runs.push({
      key: a.id,
      action: a.action,
      risk: a.risk,
      outcome: a.outcome,
      count: 1,
      said: toolSentence(a.action, status, a.outcome === "error"),
      whats: a.what ? [a.what] : [],
      error: a.error,
    });
  }
  return runs;
}

const APPROVAL: Record<string, { word: string; tone: Tone }> = {
  pending: { word: "Waiting on you", tone: "warning" },
  executing: { word: "Doing it", tone: "neutral" },
  executed: { word: "You said yes", tone: "positive" },
  denied: { word: "You said no", tone: "neutral" },
  failed: { word: "Didn't go through", tone: "danger" },
  expired: { word: "Ran out", tone: "neutral" },
};

/** An approval's state in a few words, and its badge's tone. */
export const approvalOf = (status: string) =>
  APPROVAL[status] ?? { word: status, tone: "neutral" as const };

const TOUCHED: Record<TimelineTouched["how"], string> = {
  made: "Made",
  changed: "Changed",
  trashed: "Trashed",
};

/** How a card touched a record, in a word. */
export const touchedHow = (how: TimelineTouched["how"]) => TOUCHED[how];
