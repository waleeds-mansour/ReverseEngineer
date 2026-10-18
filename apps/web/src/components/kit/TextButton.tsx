// A button that reads as a link: words in the accent's text shade. It's for an action in a sentence
// (Show them, Try again), or one standing alone where a whole button would be too loud (a list
// row's name, Read all, Join video call); with href it's a link that looks the same. A control
// that stands on its own as a control is a Button.

import { type JSX, Show } from "solid-js";

const LOOK =
  "cursor-pointer rounded-xs text-left text-accent-ink underline-offset-2 disabled:cursor-not-allowed disabled:text-ink-subtle disabled:no-underline";

// In a sentence it's underlined: its colour alone is under 3:1 against the words around it (WCAG
// 1.4.1). On a phone or a touch screen it's 44 px tall, and its margins give back all but the 20 px
// line it sits in, so the sentence keeps its spacing. Its width is its words, as WCAG 2.5.8 allows
// in running text; data-inline tells the e2e tap check so.
const INLINE =
  "underline decoration-accent-ink/40 hover:decoration-current max-md:-my-3 max-md:min-h-11 pointer-coarse:-my-3 pointer-coarse:min-h-11";

// Alone it's underlined under the pointer, and on touch it's 44 px each way with no margin given
// back: its row grows to fit it, rather than its box reaching over the next row's.
const ALONE =
  "hover:underline max-md:min-h-11 max-md:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export function TextButton(props: {
  onClick?: (e: MouseEvent) => void;
  /** A link instead of an action: it's drawn as an <a>, which can't be disabled. */
  href?: string;
  target?: string;
  title?: string;
  /** What a screen reader says, when the words alone don't say what it does. */
  label?: string;
  /** Not in a sentence: a row's name, a card's foot, a row of links. */
  alone?: boolean;
  disabled?: boolean;
  children: JSX.Element;
  /** Placement only (flex-1, truncate, block); the look is the kit's. */
  class?: string;
}) {
  const look = () => `${LOOK} ${props.alone ? ALONE : INLINE} ${props.class ?? ""}`;
  return (
    <Show
      when={props.href}
      fallback={
        // A button centres its words in the taller box by itself.
        <button
          type="button"
          class={look()}
          data-inline={props.alone ? undefined : ""}
          disabled={props.disabled}
          title={props.title}
          aria-label={props.label}
          onClick={(e) => props.onClick?.(e)}
        >
          {props.children}
        </button>
      }
    >
      {(href) => (
        // A link is inline, which takes no height and puts its words at the top of a taller box:
        // inline-flex lets it grow on a touch screen and centres them, as a button does.
        <a
          href={href()}
          target={props.target}
          rel={props.target === "_blank" ? "noreferrer" : undefined}
          class={`inline-flex items-center ${look()}`}
          data-inline={props.alone ? undefined : ""}
          title={props.title}
          aria-label={props.label}
          onClick={(e) => props.onClick?.(e)}
        >
          {props.children}
        </a>
      )}
    </Show>
  );
}
