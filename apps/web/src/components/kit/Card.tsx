// A card: something to decide or to take in at a glance (one of Today's sections, an approval, a
// connection's state, the top of a record), raised a little off its pane. What you work through
// one by one stays a list of rows (D65). A card sits at Nook's first depth, shadow-1; one you can
// act on rises one level on hover, the only way a shadow ever moves.

import type { JSX } from "solid-js";

export function Card(props: {
  children: JSX.Element;
  /** The id of the card's heading, which names it for a screen reader. */
  labelledby?: string;
  /** Leaves out the padding, for rows that run to the card's edges. */
  flush?: boolean;
  /** Takes a click or opens something: it rises to shadow-2 under the pointer. */
  interactive?: boolean;
  /** Placement only (a margin, a grid cell); the look is the kit's. */
  class?: string;
}) {
  return (
    <section
      aria-labelledby={props.labelledby}
      class={`rounded-lg bg-raised shadow-1 ${props.interactive ? "transition-shadow duration-base ease-standard hover:shadow-2" : ""} ${props.flush ? "overflow-hidden" : "p-4"} ${props.class ?? ""}`}
    >
      {props.children}
    </section>
  );
}
