// The agent dock's page (src-tauri/src/nook/dock.rs). At rest it is the edge tab: a solid black tab
// flush with a side of the screen, growing out of it with a bounce when the dock first shows, with
// a dot for Pip, then what waits for the owner's yes, then any of Hearth's services that needs the
// owner, and a count badge for what waits (dockParts.ts, dockShape.ts). A dot is a blue arc spinning
// on a faint ring while its agent works, amber while it needs the owner, green for the moment it is
// done, and a quiet grey at rest, and its colours cross-fade over 500 ms. Resting the pointer on the
// tab opens the pill: the tab fades and folds into the edge while a column of capsules springs in
// beside it, with the Inbox button and its badge, the dots again, Pip's mark, the mic and "…".
// Hovering a dot there shows its status label toward the middle of the screen, with its state and
// its last line, and a click on it opens where that agent is (dockHover.ts). The pill shows only once
// Nook says it has made the window wide enough: the page asks for room as the pointer rests on the
// tab and gives it back once the pointer has moved away, after the column has faded out, one ask
// at a time so they reach Nook in order, and Nook closes it itself once the pointer has left the
// window, which the page then follows. Clicking a dot opens the bar's popover while the bar is up,
// or Hearth's window when the bar is off or the dot needs the owner; the Inbox opens what waits
// (inboxCmd), Pip's mark Pip's conversation in Hearth's window, the mic talks to Pip as talk mode's
// hotkey does, and "…", like a right click anywhere on the dock, opens Nook's menu for it. Pressing
// the tab or the pill and moving drags the tab along its edge, which Nook carries out, and the
// release of a drag clicks nothing (dockPress.ts). Nook clips the window to what the page draws,
// so the page tells it where the label is (dockLabel.ts), and only the tab's drawn outline, not
// the clear corners beside its flares, counts as on the tab. The springs are dockSpring.ts's and
// the sounds dockSound.ts's. Like the bar, the page asks Nook for its view once and says when its
// first frame is drawn (the readiness handshake), and draws only when something it shows changes.

import type {
  AgentDot,
  ChromeView,
  DockPage,
  PipMood,
  UiCmd,
} from "@/bindings";
import { applyChrome, bootTheme, pauseWhileHidden } from "./chrome";
import {
  type Box,
  cardAction,
  follow,
  inboxCmd,
  labelText,
  nookClosed,
  stays,
} from "./dockHover";
import { attr, badgeText, buildDock, el, keyed, mark, text } from "./dockParts";
import { labelReporter } from "./dockLabel";
import { presses } from "./dockPress";
import { TAB, tabLong, tabPath } from "./dockShape";
import { chime, hearing, waitingOf } from "./dockSound";
import { setSprings } from "./dockSpring";
import { afterFirstFrame, type Link, newerChrome } from "./link";
import { pipSvg } from "./pip";

/** What a click on `dot` asks of Nook. */
export function clickFor(chrome: ChromeView, dot: AgentDot | undefined): UiCmd {
  // What waits for the owner is on Hearth; anything else is in the bar's popover, when it's up.
  if (chrome.bar.shown && dot?.state !== "needs_you") {
    return { kind: "popover", open: !chrome.bar.popover };
  }
  return { kind: "open_today" };
}

/** How long the pointer rests on the tab before the pill opens, so passing by opens nothing. */
const DWELL_MS = 80;
/** How long the column takes to fade out, before the window narrows under it. */
const CLOSE_MS = 200;

const boxOf = (e: Element): Box => e.getBoundingClientRect();
/** Whether the tab is drawn under `p`: its outline, not the clear corners beside its flares. */
const onTheTab = (p: { x: number; y: number } | null) =>
  !!p && !!document.elementFromPoint(p.x, p.y)?.closest(".nd-tab");

export function startDock({ link }: { link: Link }) {
  const root = document.documentElement;
  bootTheme(root);
  pauseWhileHidden(root);
  setSprings(root);
  root.setAttribute("data-mount", "");
  const nav = document.getElementById("dock") as HTMLElement;
  const ui = buildDock(nav);
  const sound = chime();
  const ears = hearing();

  let chrome: ChromeView | null = null;
  /** Where the pointer is in the page, while it is in the dock's window. */
  let pointer: { x: number; y: number } | null = null;
  /** The pointer has rested on the tab, or clicked it. */
  let onTab = false;
  let dwell: number | undefined;
  /** The dot the label is about. */
  let hovered: string | null = null;
  /** The room last asked of Nook, whether that ask is still out, and a give-back waiting. */
  let asked = false;
  let asking = false;
  let closing: number | undefined;
  /** What the tab was last drawn for, so it is drawn again only when that changes. */
  let shaped = "";
  let mood: PipMood | null = null;
  let labelY = "";
  const tabDots = new Map<string, HTMLElement>();
  const pillDots = new Map<string, HTMLElement>();

  const shown = () => root.hasAttribute("data-open");
  const ask = (cmd: UiCmd) => void link.ask(cmd).catch(() => {});
  const settleMs = () =>
    parseFloat(
      getComputedStyle(root).getPropertyValue("--spring-general-ms"),
    ) || 360;
  const reportLabel = labelReporter(ask, settleMs);

  /** Whether the pill should be open: near it while it is, on the tab while it isn't. */
  function wanted(): boolean {
    if (!pointer || drag.dragged() || !chrome) return false;
    if (!shown()) return onTab;
    const label = root.hasAttribute("data-label") ? boxOf(ui.label) : null;
    return stays(pointer, boxOf(ui.pill), label);
  }

  /** The pill's dot under the pointer, by what is drawn there now. */
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
      onTab = false;
    }
    hear(c);
    draw();
  };

  /** A sound for what changed since the last view, never for the first one it sees. */
  function hear(c: ChromeView) {
    if (document.visibilityState !== "visible") {
      ears.forget();
      return;
    }
    const cue = ears.hear(c.agents, c.dock.feed);
    if (cue && c.dock.sounds) sound.play(cue);
  }

  /** Asks Nook for room for the pill, or gives it back, when that differs from the last ask. */
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

  /** The pill and its label follow the pointer, and Nook is asked for what that needs. */
  function track() {
    const want = wanted();
    const ids = chrome?.agents.map((a) => a.id) ?? [];
    hovered = follow(hovered, want && shown(), under(), ids);
    if (want) {
      window.clearTimeout(closing);
      closing = undefined;
      room(true);
    } else if (asked && closing === undefined) {
      // The column fades out in the room it has, and only then is the room given back.
      closing = window.setTimeout(
        () => {
          closing = undefined;
          if (wanted()) track();
          else room(false);
        },
        shown() ? CLOSE_MS : 0,
      );
    }
    attr(root, "data-open", want && chrome?.dock.open ? "" : null);
    drawLabel();
  }

  function drawLabel() {
    const dot = shown()
      ? chrome?.agents.find((a) => a.id === hovered)
      : undefined;
    for (const [id, e] of pillDots)
      attr(e, "data-hover", dot?.id === id ? "" : null);
    if (!dot) {
      attr(root, "data-label", null);
      reportLabel(null);
      return;
    }
    const { head, tail } = labelText(dot);
    if (root.hasAttribute("data-label") && ui.labelHead.textContent !== head) {
      // New words come in from below, again for every change.
      const words = ui.labelHead.parentElement as HTMLElement;
      words.removeAttribute("data-swap");
      void words.offsetWidth;
      words.setAttribute("data-swap", "");
    }
    text(ui.labelHead, head);
    text(ui.labelTail, tail);
    attr(ui.label, "data-state", dot.state);
    const { label, page } = cardAction(dot.kind);
    ui.label.dataset.page = page;
    attr(ui.label, "title", label);
    const says = tail ? `${head}: ${tail}` : head;
    attr(ui.label, "aria-label", `${says}. ${label}`);
    const at = pillDots.get(dot.id)?.getBoundingClientRect();
    if (at) {
      const mid = Math.round(
        at.top + at.height / 2 - nav.getBoundingClientRect().top,
      );
      const y = `${mid}px`;
      if (y !== labelY) ui.label.style.setProperty("--label-y", y);
      labelY = y;
      // Where it goes in the window (the dock fills it), as wide as its words are now.
      const half = ui.label.offsetHeight / 2;
      const wide = ui.label.getBoundingClientRect().width;
      reportLabel({ top: mid - half, bottom: mid + half, wide });
    }
    if (!root.hasAttribute("data-label")) {
      // Put it at its dot before it shows, so it doesn't glide there from the last one.
      void ui.label.offsetWidth;
      root.setAttribute("data-label", "");
    }
  }

  const pillDot = (id: string) => {
    const b = el("button", "nd-dot");
    b.type = "button";
    b.dataset.id = id;
    b.setAttribute("aria-describedby", ui.label.id);
    b.append(mark());
    b.addEventListener("click", () => {
      if (chrome)
        void link.ask(
          clickFor(
            chrome,
            chrome.agents.find((a) => a.id === id),
          ),
        );
    });
    return b;
  };

  function drawTab(c: ChromeView) {
    const n = c.agents.length;
    const shape = `${n}:${c.dock.edge}`;
    if (shape !== shaped) {
      shaped = shape;
      const long = tabLong(n);
      ui.tab.style.setProperty("--tab-h", `${long}px`);
      ui.shape.setAttribute("viewBox", `0 0 ${TAB.deep} ${long}`);
      ui.outline.setAttribute("d", tabPath(long, c.dock.edge));
    }
    keyed(ui.tabDots, tabDots, c.agents, mark);
    const count = badgeText(waitingOf(c.agents));
    for (const badge of [ui.tabBadge, ui.inboxBadge]) {
      attr(badge, "data-n", count);
      text(badge, count ?? "");
    }
    attr(ui.inbox, "aria-label", count ? `Inbox: ${count} waiting` : "Inbox");
  }

  function drawPill(c: ChromeView) {
    keyed(ui.agents, pillDots, c.agents, pillDot);
    for (const a of c.agents) {
      attr(
        pillDots.get(a.id) as HTMLElement,
        "aria-label",
        `${a.label}: ${a.line}`,
      );
    }
    if (c.pip.mood !== mood) {
      mood = c.pip.mood;
      ui.pip.replaceChildren(pipSvg(mood, 18));
    }
    attr(ui.talk, "data-on", mood === "listening" ? "" : null);
  }

  function draw() {
    if (!chrome) return;
    applyChrome(chrome, root);
    attr(root, "data-edge", chrome.dock.edge);
    drawTab(chrome);
    drawPill(chrome);
    // The dots may have moved under a pointer that stayed still.
    track();
  }

  ui.inbox.addEventListener("click", () => ask(inboxCmd()));
  ui.pip.addEventListener("click", () =>
    ask({ kind: "dock_open", page: "conversation" }),
  );
  ui.talk.addEventListener("click", () => ask({ kind: "dock_talk" }));
  ui.more.addEventListener("click", () => ask({ kind: "dock_menu" }));
  ui.label.addEventListener("click", () => {
    const page = ui.label.dataset.page as DockPage | undefined;
    if (page) ask({ kind: "dock_open", page });
  });
  // A click on the tab opens the pill without waiting.
  ui.tab.addEventListener("click", () => {
    onTab = true;
    track();
  });

  const drag = presses({
    nav,
    pressable: [ui.tab, ui.pill],
    pressing: () => sound.unlock(),
    changed: () => track(),
    ask,
  });

  /** Whether the pointer is on the tab, and once it has rested there, the pill opens. */
  function rest() {
    const over = !shown() && onTheTab(pointer);
    if (!over) {
      window.clearTimeout(dwell);
      dwell = undefined;
      onTab = false;
    } else if (!onTab && dwell === undefined) {
      dwell = window.setTimeout(() => {
        dwell = undefined;
        onTab = onTheTab(pointer);
        track();
      }, DWELL_MS);
    }
  }

  const moved = (e: PointerEvent) => {
    drag.moved(e);
    pointer = { x: e.clientX, y: e.clientY };
    rest();
    if (!drag.dragged()) track();
  };
  const left = () => {
    pointer = null;
    rest();
    track();
  };
  document.addEventListener("pointermove", moved);
  document.addEventListener("pointerover", moved);
  root.addEventListener("pointerleave", left);

  /** The tab grows out of the edge, as when the dock first shows. */
  const grow = () => {
    root.setAttribute("data-mount", "");
    afterFirstFrame(() => root.removeAttribute("data-mount"));
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      ears.forget();
      left();
    } else grow();
  });
  link.onState(() => {});
  link.onChrome((c) => take(c, false));
  void link.ask({ kind: "ready" }).then((reply) => {
    if (newerChrome(chrome, reply.chrome)) chrome = reply.chrome;
    if (chrome) hear(chrome);
    draw();
    afterFirstFrame(() => {
      void link
        .ask({ kind: "drawn" })
        .catch(() => {})
        .finally(grow);
    });
  });
}
