// The mark on text that may carry outside content (an email, a web page): other people's words,
// which Pip treats with care, so you can too (D58). It's a warning, so it says so with a dot and
// in words, with the why on hover, as a conversation's "Read outside content" does.

import type { JSX } from "solid-js";
import { Badge } from "./kit/Badge.tsx";

export function OutsideMark(props: { children: JSX.Element; class?: string }) {
  return (
    <Badge
      tone="warning"
      class={props.class}
      title="Some of this comes from outside Nook, such as an email or a web page: other people's words, not Pip's. Pip checks with you before acting on anything that read it."
    >
      {props.children}
    </Badge>
  );
}
