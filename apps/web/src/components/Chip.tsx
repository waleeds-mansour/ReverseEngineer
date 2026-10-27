// A chip: a rounded button for something you start (Today's Plan my day, Pip's bar's Add task).
// A double-click's second click (detail 2) isn't a second tap, so a chip starts its thing once.

import type { JSX } from "solid-js";
import { Icon, type IconName } from "./icons.tsx";

export function Chip(props: {
  icon: IconName;
  onClick: (e: MouseEvent) => void;
  /** On its way: it shows it, and does nothing more until it's back (the caller checks). */
  busy?: boolean;
  /** Its look, in place of the quiet outlined one (Pip's bar's accent Add task). */
  class?: string;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      class={`inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm aria-busy:opacity-60 md:min-h-8 ${props.class ?? "shrink-0 border border-line bg-panel text-muted hover:bg-sunk hover:text-ink"}`}
      aria-busy={props.busy || undefined}
      data-chip
      onClick={(e) => e.detail < 2 && props.onClick(e)}
    >
      <Icon name={props.icon} size={15} class={props.class ? "" : "text-faint"} />
      {props.children}
    </button>
  );
}

/**
 * Keeps each of a set of chores from starting twice: while one is on its way, its chip does nothing
 * more, and the others still work.
 */
export function onceEach<T extends string>(busy: () => ReadonlySet<T>, set: (s: Set<T>) => void) {
  return async (what: T, run: () => Promise<unknown>) => {
    if (busy().has(what)) return;
    set(new Set(busy()).add(what));
    try {
      await run();
    } finally {
      set(new Set([...busy()].filter((w) => w !== what)));
    }
  };
}
