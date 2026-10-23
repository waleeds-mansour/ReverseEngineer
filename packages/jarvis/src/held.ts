// What Pip's own work tried and was held is noted for your brief, so it's held rather than lost: a
// turn's tool call, or a reflex's act. Held while background work is read-only (Spec 5), or past
// the ceiling of the job the work runs for (Spec 3).
import {
  type ActionDef,
  type Caller,
  HELD_FOR_BRIEF,
  isHeldReason,
  type Kernel,
} from "@hearth/kernel";

/** Whether a call's result says it was held for your brief. */
export function wasHeld(res: { status: string; reason?: string }): res is {
  status: "denied";
  reason: string;
} {
  return res.status === "denied" && isHeldReason(res.reason);
}

/** What a held call would have done, in its approval card's words if it has them. */
export function heldWords(def: ActionDef, input: unknown): string {
  const parsed = def.input.safeParse(input);
  let line: string | undefined;
  try {
    line = parsed.success ? def.summarize?.(parsed.data as never) : undefined;
  } catch {
    // Its line needs what only the guard fills in (a snapshot): say what the action is instead.
    line = undefined;
  }
  return (line || def.description).slice(0, 300);
}

/** The note's words: what was held, and why ("Pip's Research job only reads"). */
export function heldNote(what: string, reason: string): string {
  if (reason === HELD_FOR_BRIEF) return `Held while background work was read-only: ${what}`;
  const why = reason.replace(/,? so this was held for your brief\.$/, "");
  return `Held because ${why}: ${what}`;
}

/** Notes a held call for the brief, as the caller that was refused (it may always report). */
export async function noteHeld(
  kernel: Kernel,
  what: string,
  caller: Caller,
  reason: string,
): Promise<void> {
  const text = heldNote(what, reason);
  await kernel.execute("jarvis.observe", { kind: "followup", text }, caller);
}
