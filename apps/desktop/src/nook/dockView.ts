// The agent dock's page (src-tauri/src/nook/dock.rs): a short strip of status dots on the
// screen's left edge, Pip's first, then any of Hearth's services that needs the owner. A dot is
// accent while its agent works, warning while it needs the owner, positive for the moment it is
// done, and quiet at rest. Hovering a dot opens a card beside the strip with its label and last
// line: the page tells Nook when the pointer comes over the dock and when it leaves, and Nook
// makes the window wide enough for the card. Clicking a dot opens the bar's popover while the bar
// is up, or Hearth's window when the bar is off or the dot needs the owner. Like the bar, the page
// asks Nook for its view once and says when its first frame is drawn (the readiness handshake),
// and draws only when something it shows changes.

import type { AgentDot, ChromeView, UiCmd } from "@/bindings";
import { applyChrome, bootTheme, pauseWhileHidden } from "./chrome";
import { afterFirstFrame, type Link, newerChrome } from "./link";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function text(e: Element, value: string) {
  if (e.textContent !== value) e.textContent = value;
}

function attr(e: Element, name: string, value: string | null) {
  if (value === null) {
    if (e.hasAttribute(name)) e.removeAttribute(name);
  } else if (e.getAttribute(name) !== value) e.setAttribute(name, value);
}

/** What a click on `dot` asks of Nook. */
export function clickFor(chrome: ChromeView, dot: AgentDot | undefined): UiCmd {
  // What waits for the owner is on Hearth; anything else is in the bar's popover, when it's up.
  if (chrome.bar.shown && dot?.state !== "needs_you") {
    return { kind: "popover", open: !chrome.bar.popover };
  }
  return { kind: "open_today" };
}

export function startDock({ link }: { link: Link }) {
  const root = document.documentElement;
  bootTheme(root);
  pauseWhileHidden(root);
  const dock = document.getElementById("dock") as HTMLElement;
  const strip = el("div", "nd-strip");
  const card = el("div", "nd-card");
  card.id = "nd-card";
  card.setAttribute("role", "tooltip");
  const label = el("strong", "nd-label");
  const line = el("span", "nd-line");
  card.append(label, line);
  dock.append(strip, card);

  let chrome: ChromeView | null = null;
  /** The pointer is over the dock: Nook has made room for the card. */
  let inside = false;
  /** The dot the card is about. */
  let hovered: string | null = null;
  const dots = new Map<string, HTMLButtonElement>();

  const drawCard = () => {
    const agents = chrome?.agents ?? [];
    const at = agents.findIndex((a) => a.id === hovered);
    const dot = inside && at >= 0 ? agents[at] : undefined;
    attr(root, "data-open", dot ? "" : null);
    if (!dot) return;
    text(label, dot.label);
    text(line, dot.line);
    card.style.setProperty("--row", String(at));
  };

  const enter = (id: string) => {
    hovered = id;
    if (!inside) {
      inside = true;
      void link.ask({ kind: "dock_hover", open: true });
    }
    drawCard();
  };

  const leave = () => {
    hovered = null;
    if (inside) {
      inside = false;
      void link.ask({ kind: "dock_hover", open: false });
    }
    drawCard();
  };

  const makeDot = (id: string) => {
    const b = el("button", "nd-dot");
    b.type = "button";
    b.setAttribute("aria-describedby", card.id);
    b.append(el("i", ""));
    b.addEventListener("mouseenter", () => enter(id));
    b.addEventListener("click", () => {
      if (!chrome) return;
      void link.ask(
        clickFor(
          chrome,
          chrome.agents.find((a) => a.id === id),
        ),
      );
    });
    return b;
  };

  /** Keeps each agent's button while it is there, in Nook's order. */
  const drawDots = (agents: AgentDot[]) => {
    const keep = new Set(agents.map((a) => a.id));
    for (const [id, b] of dots) {
      if (!keep.has(id)) {
        b.remove();
        dots.delete(id);
      }
    }
    agents.forEach((a, i) => {
      let b = dots.get(a.id);
      if (!b) {
        b = makeDot(a.id);
        dots.set(a.id, b);
      }
      if (strip.children[i] !== b) {
        strip.insertBefore(b, strip.children[i] ?? null);
      }
      attr(b, "data-state", a.state);
      attr(b, "data-kind", a.kind);
      attr(b, "aria-label", `${a.label}: ${a.line}`);
    });
  };

  const draw = () => {
    if (!chrome) return;
    applyChrome(chrome, root);
    attr(root, "data-edge", chrome.dock.edge);
    drawDots(chrome.agents);
    drawCard();
  };

  root.addEventListener("mouseleave", leave);
  link.onState(() => {});
  link.onChrome((c) => {
    if (newerChrome(chrome, c)) {
      chrome = c;
      draw();
    }
  });
  void link.ask({ kind: "ready" }).then((reply) => {
    if (newerChrome(chrome, reply.chrome)) chrome = reply.chrome;
    draw();
    afterFirstFrame(() => void link.ask({ kind: "drawn" }));
  });
}
