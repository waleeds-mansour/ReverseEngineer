// Nook's button: one action, its verb in a word or three, and an icon before it where that helps.
// components/ui.tsx re-exports it, so views import it from there as they always did; it lives here
// so the pane header and the kit's IconButton can use it too.

import { children, type JSX, Show } from "solid-js";
import { Icon, type IconName } from "../icons.tsx";

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  /**
   * primary is a window's one main action and secondary (the default) the rest. quiet sits in
   * toolbars, and beside a primary as its lesser choice. danger fills red: only inside an Alert.
   */
  variant?: ButtonVariant;
  /** md (28 px) by default; sm (22 px) in rows and headers; lg (36 px) on a card of its own. */
  size?: ButtonSize;
  /**
   * Red words on a secondary or quiet button, for a one-click Disconnect, Forget or Remove. It
   * goes once those ask first in an Alert (1e), whose own button is variant="danger".
   */
  tone?: "danger";
  /** Drawn before its words, or alone (then label is required). */
  icon?: IconName;
  children?: JSX.Element;
  /** What a screen reader says. A button with only an icon needs it, and shows it as its tooltip. */
  label?: string;
  title?: string;
  /** "submit" sends its form, so Enter in any of the form's fields does too. */
  type?: "button" | "submit";
  /** A link that looks like a button (Join a call): it's drawn as an <a>, which can't be disabled. */
  href?: string;
  target?: string;
  /** A single toggle: whether it's on. A screen reader says "pressed". */
  pressed?: boolean;
  /** It folds what it's in, which is open: a screen reader says "expanded". */
  expanded?: boolean;
  /**
   * A sentence for a label (Always allow's "messaging Priya Nair on Slack"): its words wrap and the
   * button grows, rather than run off a phone. Every other label stays on one line.
   */
  wrap?: boolean;
  disabled?: boolean;
  onClick?: (e: MouseEvent) => void;
  ref?: (el: HTMLElement) => void;
  /** Placement only (a margin, w-full, shrink-0); the look is the kit's. */
  class?: string;
  /** @deprecated variant instead: plain is secondary, jarvis primary, danger tone="danger". Until 4z. */
  kind?: "primary" | "plain" | "quiet" | "danger" | "jarvis";
  /** @deprecated size="sm" instead. Until 4z. */
  small?: boolean;
  /** @deprecated type="submit" instead. Until 4z. */
  submit?: boolean;
}

/** The older kinds, so a branch written before 1b still builds and looks as 1b draws it. */
const KIND = {
  primary: "primary",
  plain: "secondary",
  quiet: "quiet",
  danger: "secondary",
  jarvis: "primary",
} as const;

// Disabled comes after hover and active in Tailwind's order, so a disabled button never lights up.
// Its hairline edge keeps it a button on the surface-3 cards Settings uses, where the fill alone
// would melt into the card. High contrast's hairline is solid black, the same edge an enabled
// button has there, so a disabled one is dashed instead.
// A fingertip needs 44 px each way, on a phone and on any touch screen; a pointer doesn't.
const BASE =
  "inline-flex cursor-pointer items-center justify-center gap-1.5 font-medium select-none transition-[background-color,color,box-shadow,scale] duration-fast ease-standard disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-ink-subtle disabled:shadow-none disabled:inset-ring disabled:inset-ring-hairline contrast:disabled:inset-ring-0 contrast:disabled:outline-1 contrast:disabled:-outline-offset-1 contrast:disabled:outline-dashed contrast:disabled:outline-ink-subtle max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

// A pressed toggle (the canvas's current tool) takes the accent's tint, as a Mac toolbar's does:
// surface-3 barely shows in the dark themes, and is the very fill of a Settings card. High
// contrast's tint is too faint to see, so there it's the solid accent it was before Nook.
const PRESSED =
  "aria-pressed:bg-accent-soft aria-pressed:text-accent-ink contrast:aria-pressed:bg-accent contrast:aria-pressed:text-on-accent";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: `bg-surface-1 shadow-1 active:bg-surface-2 ${PRESSED}`,
  quiet: `hover:bg-surface-3 ${PRESSED}`,
  danger: "bg-danger text-on-status hover:brightness-95",
};

// h is the control height, and grow the least height a wrapping button keeps.
const SIZE: Record<
  ButtonSize,
  { h: string; grow: string; box: string; pad: string; square: string; icon: number }
> = {
  // On a phone a small button is as tall as the rest, so its words are the same 13 px.
  sm: {
    h: "h-control-sm",
    grow: "min-h-control-sm",
    box: "rounded-sm text-xs max-md:text-callout",
    pad: "px-2 max-md:px-3",
    square: "w-control-sm",
    icon: 14,
  },
  md: {
    h: "h-control-md",
    grow: "min-h-control-md",
    box: "rounded-sm text-callout",
    pad: "px-3",
    square: "w-control-md",
    icon: 16,
  },
  lg: {
    h: "h-control-lg",
    grow: "min-h-control-lg",
    box: "rounded-md text-body",
    pad: "px-5",
    square: "w-control-lg",
    icon: 16,
  },
};

export function Button(props: ButtonProps) {
  const content = children(() => props.children);
  const variant = () => props.variant ?? KIND[props.kind ?? "plain"];
  const tone = () => props.tone ?? (props.kind === "danger" ? "danger" : undefined);
  const size = () => SIZE[props.size ?? (props.small ? "sm" : "md")];
  const square = () => props.icon !== undefined && content.toArray().length === 0;
  const look = () => {
    const v = variant();
    // Only the unfilled variants take a text colour here, so it's never set twice.
    const ink = v === "primary" || v === "danger" ? "" : tone() ? "text-danger" : "text-ink";
    const s = size();
    const fit = square() ? `${s.square} px-0` : s.pad;
    const box = props.wrap ? `${s.grow} py-0.5 text-left` : `${s.h} whitespace-nowrap`;
    return `${BASE} ${VARIANT[v]} ${ink} ${s.box} ${box} ${fit} ${props.class ?? ""}`;
  };
  const title = () => props.title ?? (square() ? props.label : undefined);
  const inner = () => (
    <>
      <Show when={props.icon}>{(name) => <Icon name={name()} size={size().icon} />}</Show>
      {content()}
    </>
  );
  return (
    <Show
      when={props.href}
      fallback={
        <button
          ref={(el) => props.ref?.(el)}
          type={props.type ?? (props.submit ? "submit" : "button")}
          class={`${look()} enabled:active:scale-[.97]`}
          disabled={props.disabled}
          title={title()}
          aria-label={props.label}
          aria-pressed={props.pressed}
          aria-expanded={props.expanded}
          onClick={(e) => props.onClick?.(e)}
        >
          {inner()}
        </button>
      }
    >
      {(href) => (
        <a
          ref={(el) => props.ref?.(el)}
          href={href()}
          target={props.target}
          rel={props.target === "_blank" ? "noreferrer" : undefined}
          class={`${look()} active:scale-[.97]`}
          title={title()}
          aria-label={props.label}
          onClick={(e) => props.onClick?.(e)}
        >
          {inner()}
        </a>
      )}
    </Show>
  );
}
