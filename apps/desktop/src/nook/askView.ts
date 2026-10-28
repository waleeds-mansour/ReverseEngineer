// The quick-ask box (ask.html, hearth/quick_ask.rs): type a request for Pip and press Enter. For
// two seconds it says Sending… with an Undo, then it goes, and Pip's first words back show here;
// a click on them, or Enter on the empty box, opens the conversation in Nook. Above, the app it
// was asked over, as it goes with the message, whole, with an × to send without it. Rust decides
// all of it (quick_ask_flow.rs) and says so in a view with a seq, as a reply and as 'nook://ask';
// this page draws each view once and passes on the keys (askKeys.ts).

import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { type AskCmd, type AskView, commands } from "@/bindings";
import { editable, keyCmd } from "./askKeys";
import { applyChrome, bootTheme } from "./chrome";

export const VIEW_EVENT = "nook://ask";

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

export const askCopy = {
  label: "Ask Pip",
  placeholder: "Ask Pip anything…",
  hint: "Enter to send · Esc to close",
  waiting: "Sending…",
  undo: "Undo",
  open: "Enter opens the conversation",
  drop: "Send without this",
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text = "",
) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export function startAsk({ link }: { link: AskLink }) {
  const root = document.documentElement;
  bootTheme(root);
  const card = document.getElementById("ask") as HTMLElement;

  const fromRow = el("div", "na-from-row");
  const from = el("p", "re-caption na-from");
  const drop = el("button", "na-drop", "×");
  drop.type = "button";
  drop.title = askCopy.drop;
  drop.setAttribute("aria-label", askCopy.drop);
  fromRow.append(from, drop);
  const input = el("input", "na-input");
  input.type = "text";
  input.maxLength = 4000;
  input.placeholder = askCopy.placeholder;
  input.autocomplete = "off";
  input.setAttribute("aria-label", askCopy.label);
  const status = el("div", "na-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const said = el("span", "na-said");
  const answer = el("button", "na-answer");
  answer.type = "button";
  const undo = el("button", "re-btn re-btn--sm na-undo", askCopy.undo);
  undo.type = "button";
  const hint = el("span", "na-hint");
  status.append(said, answer, undo, hint);
  const meter = el("span", "na-meter");
  card.append(fromRow, input, status, meter);

  let shown: AskView | null = null;
  const send = (cmd: AskCmd) => {
    link.ask(cmd).then(draw, (e: unknown) => {
      said.textContent = e instanceof Error ? e.message : String(e);
      card.dataset.tone = "bad";
    });
  };

  const draw = (v: AskView) => {
    if (v.chrome) applyChrome(v.chrome, root);
    if (shown && v.seq <= shown.seq) return;
    const was = shown?.phase;
    shown = v;
    from.textContent = v.from ?? "";
    fromRow.hidden = v.from === null;
    // Too late once it goes.
    drop.hidden = v.phase === "sending";
    if (v.draft !== null) {
      input.value = v.draft;
    } else if ((was === "waiting" || was === "sending") && editable(v.phase)) {
      // It went: the box is empty for the next one.
      input.value = "";
    }
    input.readOnly = !editable(v.phase);
    card.dataset.phase = v.phase;
    card.dataset.tone = v.phase === "failed" ? "bad" : "";
    const waiting = v.phase === "waiting";
    // Sending, the note is an Undo that came too late.
    said.textContent = waiting
      ? askCopy.waiting
      : v.phase === "sending"
        ? (v.note ?? askCopy.waiting)
        : v.phase === "failed"
          ? (v.note ?? "")
          : "";
    answer.hidden = v.phase !== "sent";
    answer.textContent = v.note ?? "";
    undo.hidden = !waiting;
    hint.textContent =
      v.phase === "sent" ? askCopy.open : waiting ? "" : askCopy.hint;
    meter.hidden = !waiting;
    meter.style.setProperty("--undo-ms", `${v.undo_ms}ms`);
    if (waiting) {
      // From full to empty over what is left of the wait.
      meter.classList.remove("na-meter--run");
      void meter.offsetWidth;
      meter.classList.add("na-meter--run");
    }
    if (editable(v.phase)) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  document.addEventListener("keydown", (e) => {
    if (e.isComposing || !shown) return;
    const cmd = keyCmd(e.key, shown.phase, input.value);
    if (e.key === "Enter" || e.key === "Escape") e.preventDefault();
    if (cmd) send(cmd);
  });
  undo.addEventListener("click", () => send({ kind: "undo" }));
  drop.addEventListener("click", () => send({ kind: "drop_context" }));
  answer.addEventListener("click", () => send({ kind: "open_conversation" }));
  // Each time it comes up, the box is ready to type in.
  window.addEventListener("focus", () => {
    if (!input.readOnly) input.focus();
  });

  link.onView(draw);
  send({ kind: "ready" });
}
