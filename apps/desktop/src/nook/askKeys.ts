// What Enter and Esc do in the quick-ask box (askView.ts), by what it is doing and what is typed.
// Rust decides what each command then does (hearth/quick_ask_flow.rs).

import type { AskCmd, AskPhase } from "@/bindings";

/** The command a key sends, or null when it does nothing now. */
export function keyCmd(
  key: string,
  phase: AskPhase,
  text: string,
): AskCmd | null {
  if (key === "Escape") {
    // A send that waits is undone first; Esc again closes the box.
    return phase === "waiting" ? { kind: "undo" } : { kind: "close" };
  }
  if (key !== "Enter" || phase === "waiting" || phase === "sending")
    return null;
  if (text.trim() !== "") return { kind: "send", text };
  // Enter on the empty box after Pip's answer opens the conversation.
  return phase === "sent" ? { kind: "open_conversation" } : null;
}

/** Whether the box can be typed in: not while a send waits or goes. */
export function editable(phase: AskPhase): boolean {
  return phase !== "waiting" && phase !== "sending";
}
