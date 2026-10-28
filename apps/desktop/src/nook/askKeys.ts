// What keys do in the quick-ask box (askView.ts), by what it is doing, what is typed and what
// its mic is doing. Rust decides what each command then does (hearth/quick_ask_flow.rs).

import type { AskCmd, AskMic, AskPhase } from "@/bindings";

/** What the keys depend on. */
export interface KeyState {
  phase: AskPhase;
  text: string;
  mic: AskMic;
  /** Tab has a choice: there is an ask to continue, or Tab chose a new conversation. */
  thread: boolean;
}

/** Whether the mic listens: by a click, or while Ctrl is held. */
export function listening(mic: AskMic): boolean {
  return mic === "listening" || mic === "held";
}

/** The command a key sends, or null when it does nothing now. */
export function keyCmd(key: string, s: KeyState): AskCmd | null {
  if (key === "Escape") {
    // What the mic heard is thrown away, a send that waits is undone; Esc again closes the box.
    if (listening(s.mic)) return { kind: "stop_listening", keep: false };
    return s.phase === "waiting" ? { kind: "undo" } : { kind: "close" };
  }
  // Space, or Enter, stops a click's listening and keeps what was said; Ctrl's ends when let go.
  if (key === " " || key === "Enter") {
    if (s.mic === "listening") return { kind: "stop_listening", keep: true };
    if (s.mic === "held" || s.mic === "hearing") return null;
  }
  if (key === "Tab") {
    return s.thread && editable(s.phase) ? { kind: "fresh" } : null;
  }
  if (key !== "Enter" || !editable(s.phase)) return null;
  if (s.text.trim() !== "") return { kind: "send", text: s.text };
  // Enter on the empty box after Pip's answer opens the conversation.
  return s.phase === "sent" ? { kind: "open_conversation" } : null;
}

/** Whether the box can be typed in: not while a send waits or goes. */
export function editable(phase: AskPhase): boolean {
  return phase !== "waiting" && phase !== "sending";
}

/** Whether keys type into the box now: not while the mic listens or writes down either. */
export function typable(phase: AskPhase, mic: AskMic): boolean {
  return editable(phase) && !listening(mic) && mic !== "hearing";
}
