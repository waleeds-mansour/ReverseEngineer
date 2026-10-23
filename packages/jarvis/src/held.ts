// While background work is read-only (Spec 5), what Pip's own work tried and was refused is noted
// for your brief, so it's held rather than lost: a turn's tool call, or a reflex's act.
import { type ActionDef, type Caller, HELD_FOR_BRIEF, type Kernel } from "@hearth/kernel";

/** Whether a call's result says it was held because background work is read-only. */
export function wasHeld(res: { status: string; reason?: string }): boolean {
  return res.status === "denied" && res.reason === HELD_FOR_BRIEF;
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

/** Notes a held call for the brief, as the caller that was refused (it may keep notes). */
export async function noteHeld(kernel: Kernel, what: string, caller: Caller): Promise<void> {
  const text = `Held while background work was read-only: ${what}`;
  await kernel.execute("jarvis.observe", { kind: "followup", text }, caller);
}
