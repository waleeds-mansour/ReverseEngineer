// The agent dock's page, built once (dockView.ts and dockNotch.ts draw into it): the notch, one
// black SVG path the size of the window with its hairline; the agents' dots, which sit in the tab
// at rest and move into the column as it opens; the column's buttons (the Inbox, Pip's mark, the
// mic, a slot for "point at it", which lane O7 fills and which stays hidden until then, and "…");
// the count badge, which moves from the tab to the Inbox; and the box beside the column, which
// holds a panel's content or a hovered dot's label. Every dot is a ring that spins while its agent
// works and a solid that takes the other states' colours, cross-fading as the state changes.

import type { AgentDot } from "@/bindings";
import { icon, NOTCH, svg } from "./dockShape";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

export function text(e: Element, value: string) {
  if (e.textContent !== value) e.textContent = value;
}

export function attr(e: Element, name: string, value: string | null) {
  if (value === null) {
    if (e.hasAttribute(name)) e.removeAttribute(name);
  } else if (e.getAttribute(name) !== value) e.setAttribute(name, value);
}

/** A dot: the ring and the solid, one over the other. */
export function mark(): HTMLElement {
  const m = el("span", "nd-mark");
  m.setAttribute("aria-hidden", "true");
  m.append(el("i", "nd-ring"), el("i", "nd-solid"));
  return m;
}

function button(cls: string, label: string) {
  const b = el("button", cls);
  b.type = "button";
  b.setAttribute("aria-label", label);
  return b;
}

export interface DockParts {
  shape: SVGSVGElement;
  fill: SVGPathElement;
  line: SVGPathElement;
  dots: HTMLElement;
  /** The column's buttons, which fade in as it opens. */
  column: HTMLElement;
  inbox: HTMLButtonElement;
  pip: HTMLButtonElement;
  talk: HTMLButtonElement;
  /** "Point at it": lane O7's, hidden until then. */
  point: HTMLButtonElement;
  more: HTMLButtonElement;
  badge: HTMLElement;
  /** Beside the column: a panel's content, or the lip with a dot's label. */
  box: HTMLElement;
  /** The status label: one button, which opens where the hovered dot's agent is. */
  lip: HTMLButtonElement;
  lipHead: HTMLElement;
  lipTail: HTMLElement;
}

export function buildDock(nav: HTMLElement): DockParts {
  const shape = svg("svg", { class: "nd-shape" });
  shape.setAttribute("aria-hidden", "true");
  const fill = svg("path", { class: "nd-fill" });
  const line = svg("path", { class: "nd-line" });
  shape.append(fill, line);

  const dots = el("div", "nd-dots");
  dots.setAttribute("role", "group");
  dots.setAttribute("aria-label", "Agents");

  const column = el("div", "nd-col");
  const inbox = button("nd-item", "Inbox");
  inbox.dataset.item = "inbox";
  inbox.append(icon("inbox", NOTCH.glyph));
  const pip = button("nd-item", "Pip");
  pip.dataset.item = "pip";
  const talk = button("nd-item", "Talk to Pip");
  talk.dataset.item = "talk";
  talk.append(icon("mic", NOTCH.glyph));
  const point = button("nd-item", "Point at it");
  point.dataset.item = "point";
  point.hidden = true;
  point.append(icon("point", NOTCH.glyph));
  const more = button("nd-item", "More");
  more.dataset.item = "more";
  more.setAttribute("aria-haspopup", "menu");
  more.append(icon("more", NOTCH.glyph));
  column.append(inbox, pip, talk, point, more);

  const badge = el("span", "nd-badge");
  badge.setAttribute("aria-hidden", "true");

  const box = el("div", "nd-box");
  const lip = el("button", "nd-lip");
  lip.type = "button";
  lip.id = "nd-lip";
  const words = el("span", "nd-lip-text");
  const lipHead = el("b", "nd-lip-head");
  const lipTail = el("span", "nd-lip-tail");
  words.append(lipHead, lipTail);
  const chevron = el("span", "nd-chev");
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  lip.append(el("i", "nd-lip-dot"), words, chevron);
  box.append(lip);

  nav.append(shape, box, dots, column, badge);
  return {
    shape,
    fill,
    line,
    dots,
    column,
    inbox,
    pip,
    talk,
    point,
    more,
    badge,
    box,
    lip,
    lipHead,
    lipTail,
  };
}

/**
 * Keeps one element per dot in `box`, made by `make` and kept while its dot is there, in Nook's
 * order, each saying its dot's state. Every other spinner turns a little slower, so two never
 * turn together.
 */
export function keyed(
  box: HTMLElement,
  made: Map<string, HTMLElement>,
  agents: readonly AgentDot[],
  make: (id: string) => HTMLElement,
) {
  const keep = new Set(agents.map((a) => a.id));
  for (const [id, e] of made) {
    if (!keep.has(id)) {
      e.remove();
      made.delete(id);
    }
  }
  agents.forEach((a, i) => {
    let e = made.get(a.id);
    if (!e) {
      e = make(a.id);
      made.set(a.id, e);
    }
    if (box.children[i] !== e) box.insertBefore(e, box.children[i] ?? null);
    attr(e, "data-state", a.state);
    attr(e, "data-slow", i % 2 === 1 ? "" : null);
  });
}

/** The badge's text for `n` waiting, or null for none. */
export const badgeText = (n: number) =>
  n <= 0 ? null : n > 99 ? "99+" : String(n);
