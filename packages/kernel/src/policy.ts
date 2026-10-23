// Who may do what, and when Jarvis has to ask first (PLAN.md section 5.5).
import type { Risk } from "@hearth/core";
import type { ActionDef, Caller } from "./types.ts";

export type Decision =
  | { kind: "allow" }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

const allow: Decision = { kind: "allow" };
const ask = (reason: string): Decision => ({ kind: "ask", reason });
const deny = (reason: string): Decision => ({ kind: "deny", reason });

/**
 * Whether a kind of caller may call an action at all. An action with no `callers` list is for
 * everyone but Slack members: a member may call only what names `member`, so an action added
 * later is closed to them unless it says otherwise (D62).
 */
function mayCall(action: Pick<ActionDef, "callers">, kind: Caller["kind"]): boolean {
  if (action.callers) return action.callers.includes(kind);
  return kind !== "member";
}

/** What a member's turn never does, whatever the action says: change your own accounts, delete,
 * or touch credentials (D62). */
const BEYOND_MEMBERS: Risk[] = ["self_external", "destructive", "secret"];

/** How every held call's reason ends, so the turn, the brief and What Pip did can tell. */
const HELD = "so this was held for your brief.";

/** Why background work's call was refused while read-only. The turn notes it for the brief. */
export const HELD_FOR_BRIEF = `Pip's background work is read-only, ${HELD}`;

/** Whether a refusal was a hold: background read-only (Spec 5) or a job's ceiling (Spec 3). */
export const isHeldReason = (reason: string | null | undefined): boolean =>
  Boolean(reason?.endsWith(HELD));

/** Risks in order of reach, for a ceiling to compare against. */
const REACH: Record<Risk, number> = {
  read: 0,
  internal: 1,
  self_external: 2,
  outward: 3,
  destructive: 4,
  secret: 5,
};

/**
 * A cap on a call of Pip's: anything that reaches further than `risk` is refused with `reason`
 * and noted for your brief rather than asked about, so nothing wakes you for it.
 */
export interface Hold {
  risk: Risk;
  reason: string;
  /** A call that would ask you anyway (an address only outside content showed) is held too. */
  asks?: boolean;
}

/** While background work is read-only, a proactive turn reads and keeps its notes (Spec 5). */
export const BACKGROUND_READ_ONLY: Hold = { risk: "internal", reason: HELD_FOR_BRIEF, asks: true };

const CEILING_WORDS: Record<string, string> = {
  read: "only reads",
  internal: "only reads and changes things in Nook",
  self_external: "doesn't do what others would see",
  outward: "doesn't do what's hard to undo",
};

/**
 * A job's ceiling (Spec 3). Its reports (a note for your brief, a card, a comment) stay within any
 * ceiling, so even a job that only reads can tell you what it found.
 */
export function roleHold(name: string, ceiling: Risk): Hold {
  const words = CEILING_WORDS[ceiling] ?? `stops at ${ceiling}`;
  return { risk: ceiling, reason: `Pip's ${name} job ${words}, ${HELD}` };
}

/** The first hold a call breaks, if any. */
function heldBy(
  action: Pick<ActionDef, "risk" | "reports">,
  caller: Caller,
  holds: readonly Hold[],
): Hold | undefined {
  if (action.reports) return undefined;
  return holds.find(
    (h) => REACH[action.risk] > REACH[h.risk] || (h.asks === true && Boolean(caller.askFirst)),
  );
}

/**
 * Decides whether a call runs now, waits for your approval, or is refused.
 * `standingRule` is true when you've written "this principal may do this action without asking".
 * `holds` cap Pip's call: background work while read-only, and its turn's job (guard.ts).
 */
export function decide(
  action: Pick<ActionDef, "risk" | "callers" | "reports">,
  caller: Caller,
  standingRule: boolean,
  holds: readonly Hold[] = [],
): Decision {
  if (!mayCall(action, caller.kind)) {
    return deny(
      action.callers
        ? `Only ${action.callers.join(", ")} may do this.`
        : "Slack members can't do this.",
    );
  }
  const risk: Risk = action.risk;
  switch (caller.kind) {
    case "owner":
      return allow;
    case "system":
      if (risk === "secret") return deny("System jobs never touch credentials through actions.");
      if (risk === "outward" || risk === "destructive") return ask("Started by an automatic job.");
      return allow;
    case "agent": {
      if (risk === "secret") return deny("Pip never touches credentials.");
      // Work you didn't start while background work is read-only, or a job's turn reaching past
      // its ceiling: refused rather than asked, and noted for your brief, so nothing wakes you.
      const held = heldBy(action, caller, holds);
      if (held) return deny(held.reason);
      if (caller.askFirst) return ask(caller.askFirst);
      const untrusted = caller.origin === "untrusted";
      if (risk === "read" || risk === "internal") return allow;
      if (risk === "self_external") {
        return untrusted
          ? ask("Triggered by outside content, and it changes your own account.")
          : allow;
      }
      // outward or destructive
      if (standingRule && !untrusted) return allow;
      return ask(
        risk === "outward"
          ? "Other people would see this, so it needs your yes."
          : "This is hard to undo, so it needs your yes.",
      );
    }
    case "mcp_client":
      if (risk === "outward") return deny("Outside agents can't act in your name.");
      if (risk === "secret") return deny("Outside agents never touch credentials.");
      if (risk === "read" || risk === "internal") return allow;
      return ask("An outside agent asked for this.");
    case "integration":
      if (risk === "read" || risk === "internal") return allow;
      return deny("Integrations only sync records into Nook.");
    case "member":
      // A Slack member's turn, on an action that names members (D62). A member's turn is always
      // outside content, so its standing rule is the one you hold for members ("Jarvis answers
      // members on its own"); a member or channel on review sets askFirst.
      if (BEYOND_MEMBERS.includes(risk)) return deny("Slack members can't do this.");
      if (caller.askFirst) return ask(caller.askFirst);
      if (risk === "read" || risk === "internal") return allow;
      return standingRule ? allow : ask("A reply to a Slack member waits for your yes.");
  }
}

/** Whether an action should even be listed for a caller (MCP clients never see send tools). */
export function isVisibleTo(
  action: Pick<ActionDef, "risk" | "callers">,
  kind: Caller["kind"],
): boolean {
  if (!mayCall(action, kind)) return false;
  if (kind === "mcp_client" && (action.risk === "outward" || action.risk === "secret"))
    return false;
  if (kind === "agent" && action.risk === "secret") return false;
  if (kind === "member" && BEYOND_MEMBERS.includes(action.risk)) return false;
  return true;
}
