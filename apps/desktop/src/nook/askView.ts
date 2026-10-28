// The quick-ask box (ask.html, hearth/quick_ask.rs): type a request for Pip, or click the mic and
// say it, and press Enter. What the mic heard is typed out into the box to read over first
// (askType.ts). After Enter a ring fills for two seconds beside an Esc key that takes it back;
// then it goes, the pill says "Sent to Pip" with a check, and a beat later the box closes and
// the app it was over has the focus again, unless you've started typing the next one. Above, the
// app it was asked over, as it goes with the message, whole, with an × to send without it; below,
// the conversation a follow-up continues, with Tab for a new one, and which keys do what. Rust
// decides all of it (quick_ask_flow.rs) and says so in a view with a seq, as a reply and as
// 'nook://ask'; this page draws each view once and passes on the keys (askKeys.ts).

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type AskCmd, type AskView, commands } from "@/bindings";
import { editable, keyCmd, listening, typable } from "./askKeys";
import { askCopy, buildAsk, hintFor } from "./askParts";
import { type Typing, typeOut } from "./askType";
import { applyChrome, bootTheme } from "./chrome";

export { askCopy };
export const VIEW_EVENT = "nook://ask";
/** The ring fills over the whole wait for an Undo (UNDO_FOR in quick_ask_flow.rs). */
const RING_MS = 2000;
/** How long "Sent to Pip" shows before the box closes by itself. */
const BEAT_MS = 1400;

export interface AskLink {
  ask(cmd: AskCmd): Promise<AskView>;
  onView(handler: (view: AskView) => void): void;
}

export const tauriAsk: AskLink = {
  ask: async (cmd) => {
    const reply = await commands.askPip(cmd);
    if (reply.status === "error") throw new Error(reply.error);
    return reply.data;
  },
  // Its own window only, as Nook's other pages listen.
  onView: (handler) => {
    void getCurrentWebviewWindow().listen<AskView>(VIEW_EVENT, (e) =>
      handler(e.payload),
    );
  },
};

export function startAsk({ link }: { link: AskLink }) {
  const root = document.documentElement;
  bootTheme(root);
  const card = document.getElementById("ask") as HTMLElement;
  const p = buildAsk(card);
  const { input } = p;
  const still = () =>
    root.hasAttribute("data-reduced") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let shown: AskView | null = null;
  let typing: Typing | null = null;
  let beat: number | undefined;
  const send = (cmd: AskCmd) => {
    link.ask(cmd).then(draw, (e: unknown) => {
      p.said.textContent = e instanceof Error ? e.message : String(e);
      card.dataset.tone = "bad";
    });
  };

  /** "Sent to Pip" in the pill until something is typed there again. */
  const landed = (on: boolean) => card.toggleAttribute("data-landed", on);

  const drawFoot = (v: AskView) => {
    const waits = v.phase === "waiting" || v.phase === "sending";
    p.thread.hidden = v.continuing === null && !v.fresh;
    p.threadText.textContent = v.fresh
      ? askCopy.fresh
      : `${askCopy.continuing} ${v.continuing ?? ""}`;
    p.threadKey.hidden = waits;
    p.threadTail.hidden = waits;
    p.threadTail.textContent = v.fresh ? askCopy.toContinue : askCopy.forNew;
    // Sent, the pill says so: the note here is only Pip's own words.
    p.said.textContent =
      v.phase === "sent" || v.phase === "waiting" ? "" : (v.note ?? "");
    p.answer.hidden = !(v.phase === "sent" && v.answered);
    p.answer.textContent = v.answered ? (v.note ?? "") : "";
    p.hint.textContent = hintFor(v);
  };

  const drawMic = (v: AskView) => {
    const on = listening(v.mic);
    card.dataset.mic = v.mic;
    p.mic.disabled =
      v.mic === "busy" || v.mic === "hearing" || !editable(v.phase);
    const label = on
      ? askCopy.micStop
      : v.mic === "busy"
        ? askCopy.micBusy
        : askCopy.mic;
    p.mic.title = label;
    p.mic.setAttribute("aria-label", label);
    p.mic.setAttribute("aria-pressed", String(on));
    input.placeholder = on
      ? askCopy.listening
      : v.mic === "hearing"
        ? askCopy.hearing
        : askCopy.placeholder;
  };

  const drawRing = (v: AskView) => {
    p.undo.hidden = v.phase !== "waiting";
    if (v.phase !== "waiting") return;
    // From where the wait is now to full, in step with Rust's clock.
    const left = Math.min(RING_MS, Math.max(0, v.undo_ms));
    p.ringFill.classList.remove("na-ring-fill--run");
    void p.ringFill.getBoundingClientRect();
    p.ringFill.style.animationDelay = `${left - RING_MS}ms`;
    p.ringFill.classList.add("na-ring-fill--run");
  };

  const draw = (v: AskView) => {
    if (v.chrome) applyChrome(v.chrome, root);
    if (shown && v.seq <= shown.seq) return;
    const was = shown?.phase;
    shown = v;
    p.from.textContent = v.from ?? "";
    p.fromRow.hidden = v.from === null;
    // Too late once it goes.
    p.drop.hidden = v.phase === "sending";
    if (v.draft !== null) {
      typing?.finish();
      input.value = v.draft;
    } else if ((was === "waiting" || was === "sending") && editable(v.phase)) {
      // It went: the box is empty for the next one.
      input.value = "";
    }
    if (v.heard !== null) {
      typing?.finish();
      typing = typeOut(input, v.heard, still(), () => {
        typing = null;
      });
    }
    input.readOnly = !typable(v.phase, v.mic);
    card.dataset.phase = v.phase;
    card.dataset.tone = v.phase === "failed" ? "bad" : "";
    p.sentText.textContent = v.answered
      ? askCopy.sent
      : (v.note ?? askCopy.sent);
    if (v.phase === "sent" && was !== "sent") {
      landed(true);
      // A beat to see it went, then the box gets out of the way.
      window.clearTimeout(beat);
      beat = window.setTimeout(() => {
        const idle = shown?.phase === "sent" && input.value === "";
        if (idle && card.hasAttribute("data-landed") && document.hasFocus())
          send({ kind: "close" });
      }, BEAT_MS);
    } else if (v.phase !== "sent") {
      landed(false);
    }
    drawMic(v);
    drawRing(v);
    drawFoot(v);
    // Listening too, so Space reaches the page rather than the mic's button.
    if (!input.readOnly || listening(v.mic)) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || !shown) return;
    // A key ends the typing out at once, so what it does sees all of it.
    typing?.finish();
    const cmd = keyCmd(e.key, {
      phase: shown.phase,
      text: input.value,
      mic: shown.mic,
      thread: shown.continuing !== null || shown.fresh,
    });
    const ours = e.key === "Enter" || e.key === "Escape";
    if (ours || cmd || (e.key === " " && input.readOnly)) e.preventDefault();
    // Space held down stops it once.
    if (cmd && !(e.repeat && cmd.kind === "stop_listening")) send(cmd);
  });
  input.addEventListener("input", () => landed(false));
  p.mic.addEventListener("click", () =>
    send(
      shown && listening(shown.mic)
        ? { kind: "stop_listening", keep: true }
        : { kind: "listen" },
    ),
  );
  p.undo.addEventListener("click", () => send({ kind: "undo" }));
  p.drop.addEventListener("click", () => send({ kind: "drop_context" }));
  p.answer.addEventListener("click", () => send({ kind: "open_conversation" }));
  // Each time it comes up, the box is ready to type in.
  window.addEventListener("focus", () => {
    if (!input.readOnly) input.focus();
  });

  link.onView(draw);
  send({ kind: "ready" });
}
