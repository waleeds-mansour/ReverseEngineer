// A button that shows only an icon: closing a pane, a toolbar's tools. It's a quiet Button, so its
// name is said to a screen reader and shown as its tooltip, since there are no words on it.

import type { IconName } from "../icons.tsx";
import { Button } from "./Button.tsx";

export function IconButton(props: {
  icon: IconName;
  /** What it does, in words: its name for a screen reader, and its tooltip. */
  label: string;
  /** A longer tooltip than its name, such as one with its key: "Close pane (Alt+W)". */
  title?: string;
  onClick?: (e: MouseEvent) => void;
  /** For a tool that stays on: whether it's on. */
  pressed?: boolean;
  /** It opens something (a picker) that's open now. */
  expanded?: boolean;
  disabled?: boolean;
  /** Placement only (a margin); the look is the kit's. */
  class?: string;
  /** @deprecated the icon follows the button's size now, so this is ignored. Until 4z. */
  size?: number;
}) {
  return (
    <Button
      variant="quiet"
      icon={props.icon}
      label={props.label}
      title={props.title}
      pressed={props.pressed}
      expanded={props.expanded}
      disabled={props.disabled}
      class={`shrink-0 ${props.class ?? ""}`}
      onClick={(e) => props.onClick?.(e)}
    />
  );
}
