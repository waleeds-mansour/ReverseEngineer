// Deprecated: use Badge (components/ui.tsx). Hearth's older rounded label, kept only as another
// name for Badge, so code written against it still draws Nook's badge: a status has a dot and its
// word now, not its icon. Nothing in the web app imports it; lib/nookGuard.test.ts keeps it so.

import type { JSX } from "solid-js";
import type { IconName } from "../icons.tsx";
import { Badge } from "./Badge.tsx";

export type PillTone = "neutral" | "accent" | "jarvis" | "ok" | "warn" | "bad";

/** @deprecated Use Badge, whose tones are Nook's: neutral, accent, positive, warning, danger. */
export function Pill(props: {
  children: JSX.Element;
  tone?: PillTone;
  icon?: IconName;
  onClick?: (e: MouseEvent) => void;
  title?: string;
  class?: string;
}) {
  return (
    <Badge
      tone={props.tone}
      icon={props.icon}
      onClick={props.onClick}
      title={props.title}
      class={props.class}
    >
      {props.children}
    </Badge>
  );
}
