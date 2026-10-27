// Pip's bar, at the bottom of every screen: ask Pip anything or tell it what to do, from wherever
// you are. Enter starts a new conversation with what's typed, about what you have open (lib/
// looking.ts), and opens it over the page. A line that names a time ("dentist fri 3pm") also offers
// itself as a task due then, one tap away, without waiting for Pip; Enter still asks Pip. Pip's mark
// opens the conversation you were in, and the mic opens it listening. / puts you in the bar. Today's
// New task takes what's typed in it, as the task's title.

import { createMemo, createRoot, createSignal, Show } from "solid-js";
import { Chip, onceEach } from "../components/Chip.tsx";
import { Badge, Button, IconButton, Kbd } from "../components/ui.tsx";
import { timeNow } from "../lib/clock.ts";
import { due } from "../lib/format.ts";
import { keyLabel } from "../lib/keys.ts";
import { toast } from "../lib/live.ts";
import { onScreen } from "../lib/looking.ts";
import { layout } from "../lib/panes.ts";
import { act, useAction } from "../lib/query.ts";
import { quickAdd } from "../lib/quickadd.ts";
import { askToTalk } from "../lib/speech.ts";
import { offerAsTask } from "../lib/today.ts";
import type { SystemStatus } from "../lib/types.ts";
import type { When } from "../lib/when.ts";
import { JarvisStatusMark, jarvis } from "./JarvisPane.tsx";

/** The bar's box, while it's drawn, for /. */
let box: HTMLInputElement | undefined;

/** What's typed in the bar: there's one bar, under every screen. */
const [text, setText] = createRoot(() => createSignal(""));

/** Puts you in Pip's bar (/), or in the conversation when it's open. */
export function focusPipBar() {
  if (jarvis.open()) jarvis.toggle(true);
  else box?.focus();
}

/** Takes what's typed in the bar, leaving it empty: Today's New task starts with it. */
export function takeTyped(): string {
  const typed = text().trim();
  setText("");
  return typed;
}

export function PipBar() {
  const typed = { get: text, set: setText };
  let input!: HTMLInputElement;
  let chips!: HTMLDivElement;
  const status = useAction<SystemStatus>("system.status");
  // Read on the clock, so "in 20 min" moves on with it. The task made is the one the chip shows,
  // and the toast says the same.
  const offered = createMemo(() => offerAsTask(text(), timeNow()));
  // Kept on show while it's added, so a second click doesn't land on a chip sliding under it.
  const [adding, setAdding] = createSignal<When | null>(null);
  const task = () => adding() ?? offered();
  const [busy, setBusy] = createSignal<ReadonlySet<"task">>(new Set());
  const once = onceEach(busy, setBusy);

  /** A new conversation with what's typed, about what's open, shown over the page. */
  const ask = async () => {
    const looking = onScreen.looking();
    const r = await quickAdd(typed, (q) =>
      act<{ conversationId: string }>("chat.send", { text: q, ...(looking ? { looking } : {}) }),
    );
    if (!r) return;
    jarvis.setConversationId(r.conversationId);
    jarvis.toggle(true);
  };

  const addTask = (w: When, e: MouseEvent) =>
    once("task", async () => {
      setAdding(w);
      // The next line is typed in the bar, so the focus goes back there: not to the chip's place,
      // where a key would do nothing. Not on a touch screen, where it brings the keyboard up.
      const had =
        chips.contains(document.activeElement) && (e as PointerEvent).pointerType !== "touch";
      const made = await quickAdd(typed, () => act<{ id: string }>("task.create", w)).finally(() =>
        setAdding(null),
      );
      // Only if it's still in the chip's place, or went with it: not if you've moved it meanwhile.
      const at = document.activeElement;
      if (had && (!at || at === document.body || chips.contains(at)))
        input.focus({ preventScroll: true });
      if (made)
        toast.show(`Added “${w.title}”, due ${due(w.dueAt, w.dueIsDate)?.text ?? "then"}.`, "ok", {
          label: "Open",
          run: () => layout.open({ view: "task", id: made.id }, { beside: true }),
        });
    });

  return (
    <div class="pointer-events-auto relative mx-auto w-full max-w-[42.5rem]">
      {/* Over the bar, so offering it doesn't move the bar under your typing. */}
      <div ref={chips} class="absolute bottom-full left-0 mb-2 flex max-w-full">
        <Show when={task()}>
          {(w) => (
            <Chip
              icon="plus"
              busy={busy().has("task")}
              class="min-w-0 bg-accent-soft text-accent-ink shadow-2 hover:underline"
              onClick={(e) => void addTask(w(), e)}
            >
              <span class="truncate">
                Add task “{w().title}” · due {due(w().dueAt, w().dueIsDate)?.text}
              </span>
            </Chip>
          )}
        </Show>
      </div>
      <form
        aria-label="Pip"
        class="flex min-h-12 items-center gap-2 glass-strong rounded-xl py-1 pr-1.5 pl-1.5 shadow-3 focus-within:ring-2 focus-within:ring-accent/25"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <button
          type="button"
          class="flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-sunk max-md:size-11"
          aria-label="Open Pip"
          title={`Open Pip (${keyLabel("mod+j")})`}
          onClick={() => jarvis.toggle(true)}
        >
          <JarvisStatusMark size={20} />
        </button>
        <input
          ref={(el) => {
            input = el;
            box = el;
          }}
          class="min-h-9 min-w-0 flex-1 bg-transparent text-base placeholder:text-faint max-md:min-h-11"
          aria-label="Ask Pip or add a task"
          placeholder="Ask Pip, or tell it what to do"
          enterkeyhint="send"
          autocomplete="off"
          // The bar around it shows where you're typing; a second ring inside it would be noise.
          style={{ outline: "none" }}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        />
        <Show when={status.data?.jarvisPaused}>
          <Badge tone="warning">Paused</Badge>
        </Show>
        <Show
          when={text().trim()}
          fallback={
            <>
              <Kbd keys="/" hint class="max-md:hidden" />
              <IconButton
                icon="mic"
                label="Talk to Pip"
                title="Talk to Pip: tap, speak, tap Stop. The answer is read aloud."
                onClick={() => {
                  jarvis.toggle(true);
                  askToTalk();
                }}
              />
            </>
          }
        >
          <Button
            type="submit"
            variant="primary"
            icon="send"
            label="Ask Pip"
            title="Ask Pip (Enter)"
            class="shrink-0"
          />
        </Show>
      </form>
    </div>
  );
}
