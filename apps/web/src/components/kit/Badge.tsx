// Nook's badge: a rounded pill that says how something is in a word or two. A status (positive,
// warning, danger) has a dot before its word, so colour is never the only sign; accent means
// focused or selected; neutral is the rest (lib/status.ts). A count is a badge too: hidden at 0, and
// drawn again each time it changes so it pops in. components/ui.tsx re-exports it.

import { type JSX, Show } from "solid-js";
import { type OldTone, showsDot, type Tone, toneOf } from "../../lib/status.ts";
import { Icon, type IconName } from "../icons.tsx";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-3 text-ink",
  accent: "bg-accent-soft text-accent-ink",
  positive: "bg-ok-soft text-positive",
  warning: "bg-warn-soft text-warning",
  danger: "bg-bad-soft text-danger",
};

const PILL =
  "inline-flex h-5 shrink-0 items-center gap-[5px] rounded-pill px-2 text-caption font-semibold whitespace-nowrap";

/**
 * A fingertip needs 44 px, so on a phone or a touch screen the button itself is that big. The pill
 * keeps its 20 px height and the button reaches past it, which leaves the row's layout alone; a
 * pseudo-element wouldn't grow the button's own box, which is what a tap and FINGER_CHECK measure.
 */
const TAP = "max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export interface BadgeProps {
  /** Nook's tones; Hearth's older names (ok, warn, bad, muted, jarvis) read as one of them. */
  tone?: Tone | OldTone;
  /** One or two words. */
  children?: JSX.Element;
  /** The dot before the word: on by default for positive, warning and danger. */
  dot?: boolean;
  /** A count, shown in tabular figures and hidden at 0. */
  count?: number;
  /** What a screen reader hears after the count: "new", "to reply". */
  countLabel?: string;
  /** Before the word, for a badge that isn't a status (a date, a draft); it takes the dot's place. */
  icon?: IconName;
  /** Makes the badge's words a button. */
  onClick?: (e: MouseEvent) => void;
  /** A trailing x that takes it away, named removeLabel. */
  onRemove?: () => void;
  removeLabel?: string;
  title?: string;
  /** Placement only (a margin, a corner); the look is the kit's. */
  class?: string;
}

export function Badge(props: BadgeProps) {
  return (
    <Show when={props.count !== undefined} fallback={<Drawn {...props} />}>
      {/* Keyed on the count, so a new one is a new element and its animation runs again. */}
      <Show when={props.count} keyed>
        {(count) => <Drawn {...props} count={count} pop />}
      </Show>
    </Show>
  );
}

function Drawn(props: BadgeProps & { pop?: boolean }) {
  const tone = () => toneOf(props.tone);
  const inside = () => (
    <>
      <Show when={showsDot(tone(), props.dot, !!props.icon)}>
        <span aria-hidden="true" class="size-[7px] shrink-0 rounded-full bg-current" />
      </Show>
      <Show when={props.icon}>{(name) => <Icon name={name()} size={12} />}</Show>
      {props.children}
      <Show when={props.count}>
        {(count) => (
          <span class="tabular-nums">
            {count()}
            <Show when={props.countLabel}>
              <span class="sr-only"> {props.countLabel}</span>
            </Show>
          </span>
        )}
      </Show>
    </>
  );
  return (
    <span
      class={`${PILL} ${TONE[tone()]} ${props.pop ? "animate-badge-in" : ""} ${props.class ?? ""}`}
      title={props.title}
    >
      <Show when={props.onClick} fallback={inside()}>
        {(click) => (
          <button
            type="button"
            // It covers the whole pill, padding included, so the pill is what takes the click.
            class={`inline-flex h-full min-w-0 items-center justify-center gap-[5px] rounded-pill hover:bg-current/10 ${props.onRemove ? "-ml-2 pl-2" : "-mx-2 px-2"} ${TAP}`}
            onClick={(e) => click()(e)}
          >
            {inside()}
          </button>
        )}
      </Show>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            // On touch it's 44 px square, and its margins give back all but the 16 px it shows as.
            class="-mr-1.5 flex size-4 shrink-0 items-center justify-center rounded-full hover:bg-current/15 max-md:-mx-3.5 max-md:size-11 pointer-coarse:-mx-3.5 pointer-coarse:size-11"
            aria-label={props.removeLabel ?? "Remove"}
            title={props.removeLabel ?? "Remove"}
            onClick={(e) => {
              // Taking it off isn't a click on the row it sits in.
              e.stopPropagation();
              remove()();
            }}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </Show>
    </span>
  );
}
