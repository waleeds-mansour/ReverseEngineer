// What a meeting dragged somewhere new asks before it moves, beside where it was dropped, naming it
// and where it goes: moving it sends its guests an update, so it waits for Move. Cancel has the
// focus, so a stray Enter tells nobody; Cancel, Esc, a click elsewhere or a scroll put it back.
// A time Pip suggests asks the same way before its guests are invited, its button Invite.

import { createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Button } from "../../components/ui.tsx";
import { popoverAt } from "../../lib/calLayout.ts";

export function MoveConfirm(props: {
  /** “Move “Standup” to Thu, Oct 29, 10:30 a.m. and tell 3 guests?” */
  question: string;
  /** Where it was dropped. */
  at: DOMRect;
  /** Move it and tell them, or put it back. */
  onAnswer: (move: boolean) => void;
  /** The yes button's word: Move, or Invite. */
  yes?: string;
  /** What the question cuts short, in full: every guest, when it names only some. */
  detail?: string;
}) {
  let box!: HTMLDivElement;
  let cancel: HTMLElement | undefined;
  const id = createUniqueId();
  const [where, setWhere] = createSignal<{ top: number; left: number }>();

  onMount(() => {
    const size = { width: box.offsetWidth, height: box.offsetHeight };
    setWhere(popoverAt(props.at, size, { width: window.innerWidth, height: window.innerHeight }));
    // Once it's shown: drawn unseen to measure it, it can't take the focus till then.
    requestAnimationFrame(() => cancel?.focus({ preventScroll: true }));
    const away = (ev: Event) => {
      if (!box.contains(ev.target as Node)) props.onAnswer(false);
    };
    const gone = () => props.onAnswer(false);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", gone);
    onCleanup(() => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", gone);
    });
  });

  return (
    <Portal>
      <div
        ref={box}
        role="alertdialog"
        aria-labelledby={id}
        aria-describedby={props.detail ? `${id}-all` : undefined}
        data-product="calendar"
        class="glass-strong fixed z-(--z-popup) max-w-[calc(100vw-1rem)] rounded-lg p-3 text-sm shadow-4"
        // Drawn unseen first, to measure it, then put beside the meeting.
        style={(() => {
          const at = where();
          return at
            ? { top: `${at.top}px`, left: `${at.left}px` }
            : { top: "0px", left: "0px", visibility: "hidden" };
        })()}
        onKeyDown={(ev) => {
          // Keys pressed here are the question's, not Calendar's behind it.
          if (!ev.ctrlKey && !ev.metaKey) ev.stopPropagation();
          if (ev.key === "Escape") {
            ev.preventDefault();
            props.onAnswer(false);
          }
        }}
      >
        <p id={id} class="max-w-72 break-words" title={props.detail}>
          {props.question}
        </p>
        <Show when={props.detail}>
          <p id={`${id}-all`} class="sr-only">
            {props.detail}
          </p>
        </Show>
        <div class="mt-2.5 flex justify-end gap-2">
          <Button size="sm" ref={(el) => (cancel = el)} onClick={() => props.onAnswer(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => props.onAnswer(true)}>
            {props.yes ?? "Move"}
          </Button>
        </div>
      </div>
    </Portal>
  );
}
