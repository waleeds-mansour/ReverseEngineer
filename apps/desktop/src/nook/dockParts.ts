// The agent dock's page, built once (dockView.ts draws into it): the edge tab, with its outline,
// its dots and its count badge; the open pill, a column of four capsules (the Inbox button with
// its badge, the agents' dots, the tools, and "…"); and the status label that shows beside a
// hovered dot, which is itself the button that opens where that dot's agent is. The tools are Pip's own mark, which opens Hearth's window, the mic, which talks to
// Pip, and a slot for "point at it", which lane O7 fills and which stays hidden until then. Every
// dot is a ring that spins while its agent works and a solid that takes the other states' colours,
// cross-fading as the state changes.

import type { AgentDot } from "@/bindings";
import { icon, svg } from "./dockShape";

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
  tab: HTMLElement;
  shape: SVGSVGElement;
  outline: SVGPathElement;
  tabDots: HTMLElement;
  tabBadge: HTMLElement;
  pill: HTMLElement;
  inbox: HTMLButtonElement;
  inboxBadge: HTMLElement;
  agents: HTMLElement;
  pip: HTMLButtonElement;
  talk: HTMLButtonElement;
  /** "Point at it": lane O7's, hidden until then. */
  point: HTMLButtonElement;
  more: HTMLButtonElement;
  /** The status label: one button, which opens where the hovered dot's agent is. */
  label: HTMLButtonElement;
  labelHead: HTMLElement;
  labelTail: HTMLElement;
}

export function buildDock(nav: HTMLElement): DockParts {
  const tab = el("div", "nd-tab");
  const shape = svg("svg", { class: "nd-shape" });
  shape.setAttribute("aria-hidden", "true");
  const outline = svg("path");
  shape.append(outline);
  const tabDots = el("div", "nd-tab-dots");
  const tabBadge = el("span", "nd-badge");
  tabBadge.setAttribute("aria-hidden", "true");
  tab.append(shape, tabDots, tabBadge);

  const pill = el("div", "nd-pill");
  const inbox = button("nd-cap nd-round nd-inbox", "Inbox");
  const inboxBadge = el("span", "nd-badge");
  inbox.append(icon("inbox", 16), inboxBadge);
  const agents = el("div", "nd-cap nd-agents");
  agents.setAttribute("role", "group");
  agents.setAttribute("aria-label", "Agents");
  const tools = el("div", "nd-cap nd-tools");
  const pip = button("nd-tool", "Open Pip in Hearth");
  pip.dataset.tool = "pip";
  const talk = button("nd-tool", "Talk to Pip");
  talk.dataset.tool = "talk";
  talk.append(icon("mic", 17));
  const point = button("nd-tool", "Point at it");
  point.dataset.tool = "point";
  point.hidden = true;
  point.append(icon("point", 17));
  tools.append(pip, talk, point);
  const more = button("nd-cap nd-round nd-more", "More");
  more.append(icon("more", 18));
  pill.append(inbox, agents, tools, more);

  const label = el("button", "nd-label");
  label.type = "button";
  label.id = "nd-label";
  const labelText = el("span", "nd-label-text");
  const labelHead = el("b", "nd-label-head");
  const labelTail = el("span", "nd-label-tail");
  labelText.append(labelHead, labelTail);
  const chevron = el("span", "nd-chev");
  chevron.textContent = "›";
  chevron.setAttribute("aria-hidden", "true");
  label.append(el("i", "nd-label-dot"), labelText, chevron);

  nav.append(tab, pill, label);
  return {
    tab,
    shape,
    outline,
    tabDots,
    tabBadge,
    pill,
    inbox,
    inboxBadge,
    agents,
    pip,
    talk,
    point,
    more,
    label,
    labelHead,
    labelTail,
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
