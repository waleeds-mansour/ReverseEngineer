// The model behind Jarvis, behind one small interface: the Claude Agent SDK in production, a
// scripted brain in tests.
import type { ModelImage } from "@hearth/kernel";
import type { z } from "zod";
import type { ModelChoice } from "./models.ts";

export type Lane = "fast" | "deep";

export interface BrainTool {
  /** Tool name, e.g. "task_create" (the action name with dots as underscores). */
  name: string;
  description: string;
  input: z.ZodObject;
  /** Runs the tool and returns what the model gets back. Never throws. */
  run(input: unknown): Promise<ToolReply>;
}

/** Text for the model, and sometimes pictures to look at (a screenshot of a page). */
export type ToolReply = string | { text: string; images: ModelImage[] };

export function replyText(reply: ToolReply): string {
  return typeof reply === "string" ? reply : reply.text;
}

export interface BrainRequest {
  /**
   * The system prompt. What comes before TURN_PART is the same every turn, so it's cached
   * across turns; what follows (the time, the record, memory) is this turn's own (D82).
   */
  system: string;
  prompt: string;
  lane: Lane;
  /** The job's model and effort (D82); without one, the brain picks by lane. */
  model?: ModelChoice;
  tools: BrainTool[];
  /** False to keep the web tools off for this turn, whatever the brain allows. */
  web?: boolean;
  /** Agent session to resume, so a conversation keeps its context across turns. */
  sessionId: string | null;
  signal: AbortSignal;
  /** Model steps this go may take, if not the brain's own default (a browsing turn's more). */
  maxTurns?: number;
}

export interface BrainEvents {
  /** A streamed piece of the reply. */
  onText(delta: string): void;
  /** A complete block of reply text. */
  onMessage(text: string): void;
  /**
   * The model read outside content (the web), so the rest of the turn is untrusted. `text` is
   * what it read, so addresses in it can be followed later (D25).
   */
  onExternalContent(source: string, text?: string): void;
  /** Before a web fetch: null to allow it, or why it's refused (D25). */
  mayFetch?(url: string): string | null;
}

/** Where the cacheable part of a system prompt ends and the turn's own part starts (D82). */
export const TURN_PART = "\n\n## This turn\n";

/** Tokens a go used, by model (D82). */
export type Usage = Record<string, ModelTokens>;

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Two goes' tokens added up, by model. */
export function sumUsage(a?: Usage, b?: Usage): Usage | undefined {
  if (!a || !b) return a ?? b;
  const out: Usage = structuredClone(a);
  for (const [model, t] of Object.entries(b)) {
    const s = out[model];
    out[model] = s
      ? {
          input: s.input + t.input,
          output: s.output + t.output,
          cacheRead: s.cacheRead + t.cacheRead,
          cacheWrite: s.cacheWrite + t.cacheWrite,
        }
      : { ...t };
  }
  return out;
}

export interface BrainResult {
  text: string;
  sessionId: string | null;
  firstTokenMs: number | null;
  /** Tokens it used, by model, when the brain can tell. */
  usage?: Usage;
  /**
   * It ran out of steps before finishing, after this many: `text` is what it said last. Not a
   * failure; the session can carry on from there (B1).
   */
  outOfSteps?: { steps: number };
}

export interface Brain {
  readonly name: string;
  run(req: BrainRequest, events: BrainEvents): Promise<BrainResult>;
}
