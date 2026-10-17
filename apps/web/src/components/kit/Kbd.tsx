// A shortcut as key caps: one cap per key, named as this computer names it (Ctrl, Alt, Shift on
// Windows; ⌘ ⌥ ⇧ on a Mac), with "then" between the steps of a sequence. lib/keys.ts names the
// keys from the binding, so a cap always says what the binding does. components/ui.tsx
// re-exports it, so it's imported from there as it always was.

import { For, type JSX, Show } from "solid-js";
import { keyCaps } from "../../lib/keys.ts";

/**
 * Nook's cap: a hairline edge with a heavier bottom, so it reads as a key. In a selected row,
 * which is solid accent, it lets the accent through and takes the row's text colour.
 */
const CAP =
  "inline-flex h-5 min-w-5 items-center justify-center rounded-xs border-[0.5px] border-b-[1.5px] border-hairline bg-surface-3 px-[5px] font-mono text-kbd text-ink in-aria-selected:border-on-accent in-aria-selected:bg-transparent in-aria-selected:text-on-accent";

export function Kbd(props: {
  /** The binding, as lib/hotkeys.ts writes it: "mod+k", "shift+enter", "g i", "escape". */
  keys?: string;
  /** A cap that says this, for a key no binding names. */
  children?: JSX.Element;
  /**
   * Beside what it does (a and d on Approve and Deny): not shown on a touch screen, which has
   * no keys to press.
   */
  hint?: boolean;
  /** Placement only; the look is the kit's. */
  class?: string;
}) {
  return (
    <span
      class={`inline-flex items-center gap-0.5 ${props.hint ? "pointer-coarse:hidden" : ""} ${props.class ?? ""}`}
    >
      <Show when={props.keys} fallback={<kbd class={CAP}>{props.children}</kbd>}>
        {(keys) => (
          <For each={keyCaps(keys())}>
            {(caps, step) => (
              <>
                <Show when={step() > 0}>
                  <span class="px-0.5 text-caption text-ink-muted">then</span>
                </Show>
                <For each={caps}>
                  {(cap, i) => (
                    <>
                      {/* A screen reader hears "Ctrl+K", not "Ctrl K". */}
                      <Show when={i() > 0}>
                        <span class="sr-only">+</span>
                      </Show>
                      <kbd class={CAP}>{cap}</kbd>
                    </>
                  )}
                </For>
              </>
            )}
          </For>
        )}
      </Show>
    </span>
  );
}
