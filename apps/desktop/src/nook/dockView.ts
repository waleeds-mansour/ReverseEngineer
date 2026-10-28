// The agent dock's page (src-tauri/src/nook/dock.rs): a short strip of status dots on a side of the
// screen, Pip's first, then what waits for the owner's yes, then any of Hearth's services that
// needs the owner. A dot is accent while its agent works, warning while it needs the owner,
// positive for the moment it is done, and quiet at rest. Hovering a dot opens a card beside the
// strip with its label, last line and a button that opens where that agent is in Hearth's window
// (dockHover.ts). The card is about the dot under the pointer, read again as the pointer moves and
// as the dots change, and it stays on that dot while the pointer crosses into the card, so its
// button can be reached; it shows only once Nook says it has made the window wide enough: the page
// asks for room as the pointer comes over a dot and gives it back as it leaves, one ask at a time
// so they reach Nook in order, and Nook closes the card itself once the pointer has left the
// window, which the page then follows. Clicking a dot opens the bar's popover while the bar is up,
// or Hearth's window when the bar is off or the dot needs the owner: Today, where what waits for a
// yes is listed. A right click on the strip opens Nook's menu for the dock, and pressing the strip
// and moving it drags it along its edge, which Nook carries out; the release of a drag clicks
// nothing. Like the bar, the page asks Nook for its view once and says when its first frame is
// drawn (the readiness handshake), and draws only when something it shows changes.

import type { AgentDot, ChromeView, DockPage, UiCmd } from "@/bindings";
import { applyChrome, bootTheme, pauseWhileHidden } from "./chrome";
import { cardAction, drags, follow, nookClosed } from "./dockHover";
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
  card.setAttribute("role", "group");
  const label = el("strong", "nd-label");
  const line = el("span", "nd-line");
  const act = el("button", "nd-act");
  act.type = "button";
  card.append(label, line, act);
  dock.append(strip, card);

  let chrome: ChromeView | null = null;
  /** Where the pointer is in the page, while it is in the dock's window. */
  let pointer: { x: number; y: number } | null = null;
  /** The dot the card is about. */
  let hovered: string | null = null;
  /** The room for the card last asked of Nook, and whether that ask is still out. */
  let asked = false;
  let asking = false;
  /** Where the strip was pressed, on the screen, until the button comes up. */
  let press: { x: number; y: number } | null = null;
  /** The press became a drag: Nook moves the strip, and its release clicks nothing. */
  let dragged = false;
  const dots = new Map<string, HTMLButtonElement>();

  const drawCard = () => {
    const agents = chrome?.agents ?? [];
    const at = agents.findIndex((a) => a.id === hovered);
    // Only once Nook has made room: a card drawn before that would be cut off by the window.
    const dot = chrome?.dock.open && at >= 0 ? agents[at] : undefined;
    attr(root, "data-open", dot ? "" : null);
    if (!dot) return;
    const { label: does, page } = cardAction(dot.kind);
    text(label, dot.label);
    text(line, dot.line);
    text(act, does);
    act.dataset.page = page;
    attr(card, "aria-label", dot.label);
    card.style.setProperty("--row", String(at));
  };

  /** The dot under the pointer, by what is drawn there now. */
  const under = (): string | null => {
    if (!pointer) return null;
    const hit = document.elementFromPoint(pointer.x, pointer.y);
    return hit?.closest<HTMLElement>(".nd-dot")?.dataset.id ?? null;
  };

  /** Takes a view from Nook: as the answer to the page's own ask, or as an event. */
  const take = (c: ChromeView, answer: boolean) => {
    if (!newerChrome(chrome, c)) return;
    chrome = c;
    if (nookClosed(asked, c.dock.open, asking && !answer)) {
      asked = false;
      pointer = null;
    }
    draw();
  };

  /** Asks Nook for room for the card, or gives it back, when that differs from the last ask. */
  const room = (want: boolean) => {
    if (asking || want === asked) return;
    asked = want;
    asking = true;
    void link
      .ask({ kind: "dock_hover", open: want })
      .then((reply) => take(reply.chrome, true))
      .catch(() => {})
      .finally(() => {
        asking = false;
        // The pointer may have moved on while Nook answered.
        track();
      });
  };

  /** The card follows the pointer, and Nook is asked for what that needs. */
  function track() {
    const ids = chrome?.agents.map((a) => a.id) ?? [];
    hovered = follow(hovered, pointer !== null && !dragged, under(), ids);
    room(hovered !== null);
    drawCard();
  }

  const makeDot = (id: string) => {
    const b = el("button", "nd-dot");
    b.type = "button";
    b.dataset.id = id;
    b.setAttribute("aria-describedby", card.id);
    b.append(el("i", ""));
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

  function draw() {
    if (!chrome) return;
    applyChrome(chrome, root);
    attr(root, "data-edge", chrome.dock.edge);
    drawDots(chrome.agents);
    // The dots may have moved under a pointer that stayed still.
    track();
  }

  act.addEventListener("click", () => {
    const page = act.dataset.page as DockPage | undefined;
    if (page) void link.ask({ kind: "dock_open", page }).catch(() => {});
  });

  // The strip moves under the pointer while it is dragged, so Nook follows the pointer itself, and
  // the page only says when a press has become a drag.
  strip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY };
    dragged = false;
  });
  const pressed = (e: PointerEvent) => {
    if (!press || dragged || (e.buttons & 1) === 0) return;
    if (!drags(press, { x: e.screenX, y: e.screenY })) return;
    dragged = true;
    track();
    void link.ask({ kind: "dock_drag" }).catch(() => {});
  };
  /** The press is over: a drag's own release has had its click by the time this runs. */
  const released = () => {
    press = null;
    if (!dragged) return;
    setTimeout(() => {
      dragged = false;
      track();
    });
  };
  document.addEventListener("pointerup", released);
  // The release that ends a drag is not a click on whichever dot ends up under it.
  strip.addEventListener(
    "click",
    (e) => {
      if (!dragged) return;
      e.stopPropagation();
      e.preventDefault();
      dragged = false;
    },
    true,
  );
  // Nook's menu for the dock, never the page's own.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (strip.contains(e.target as Node))
      void link.ask({ kind: "dock_menu" }).catch(() => {});
  });

  const moved = (e: PointerEvent) => {
    // The button came up outside the window, where the page didn't see it.
    if (press && (e.buttons & 1) === 0) released();
    pressed(e);
    pointer = { x: e.clientX, y: e.clientY };
    if (!dragged) track();
  };
  const left = () => {
    pointer = null;
    track();
  };
  document.addEventListener("pointermove", moved);
  document.addEventListener("pointerover", moved);
  root.addEventListener("pointerleave", left);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") left();
  });
  link.onState(() => {});
  link.onChrome((c) => take(c, false));
  void link.ask({ kind: "ready" }).then((reply) => {
    if (newerChrome(chrome, reply.chrome)) chrome = reply.chrome;
    draw();
    afterFirstFrame(() => void link.ask({ kind: "drawn" }));
  });
}
