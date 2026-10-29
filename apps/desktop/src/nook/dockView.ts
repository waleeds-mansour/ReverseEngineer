// The agent dock's page (src-tauri/src/nook/dock.rs): the notch, one continuous black shape on the
// side of the screen that everything opens inside (dockNotch.ts draws it, dockOutline.ts and
// dockLayout.ts work it out). At rest it is the edge tab, with a dot for Pip, then what waits for
// the owner's yes, then any of Hearth's services that needs the owner, and a count badge for what
// waits. A dot is a blue arc spinning on a faint ring while its agent works, amber while it needs
// the owner, green for the moment it is done, and a quiet grey at rest.
//
// Resting the pointer on the tab for DWELL_MS, or clicking it, grows the same shape into the open
// notch: the Inbox with its badge, the dots, Pip's mark, the mic and "…", as icons on the black. It
// folds back LEAVE_MS after the pointer leaves, unless a panel that has the keyboard is open.
// Hovering a dot shows its status label in a lip of the notch, which opens where that agent is. The
// Inbox opens the Inbox's panel, Pip's mark the chat with Pip once that panel is in (Hearth's
// window until then), the mic talks to Pip as talk mode's hotkey does, and "…", like a right click
// anywhere on the dock, opens the dock's menu (notchPanel.ts, dockPanels.ts). A notice of something
// new drops out of the tab even while the notch is folded. Pressing the notch and moving drags the
// tab along its edge, which Nook carries out (dockPress.ts).
//
// The window is made once, at its biggest, and never resized: Nook clips it to what the page says
// it draws (UiCmd::DockShape), so the page tells it the notch's outline, whether it is open, and
// whether a panel holds it open. Like the bar, the page asks Nook for its view once and says when
// its first frame is drawn (the readiness handshake) (dockAsk.ts). The sounds are dockSound.ts's.

import type { ChromeView, DockPage, PipMood, UiCmd } from "@/bindings";
import { applyChrome, bootTheme, pauseWhileHidden } from "./chrome";
import { keysTeller, shapeTeller } from "./dockAsk";
import { follow } from "./dockHover";
import { panelRoom } from "./dockLayout";
import { boxFor, clickFor, drawLip } from "./dockLip";
import type { Ticker } from "./dockMotion";
import { startNotch } from "./dockNotch";
import { panelHost } from "./dockPanels";
import { attr, badgeText, buildDock, el, keyed, mark, text } from "./dockParts";
import { presses } from "./dockPress";
import { chime, hearing, waitingOf } from "./dockSound";
import { setSprings } from "./dockSpring";
import { afterFirstFrame, type Link, newerChrome } from "./link";
import { useMenu } from "./menuPanel";
import { noticeSounds } from "./noticePanel";
import { type PanelKind, panelMaker, setNotch } from "./notchPanel";
import { pipSvg } from "./pip";

/** How long the pointer rests on the tab before the notch opens, so passing by opens nothing. */
export const DWELL_MS = 60;
/** How long the notch stays open after the pointer leaves it. */
export const LEAVE_MS = 350;

export function startDock({ link, ticker }: { link: Link; ticker?: Ticker }) {
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
  /** The column is out. */
  let open = false;
  let dwell: number | undefined;
  let leaving: number | undefined;
  /** The dot the lip is about. */
  let hovered: string | null = null;
  let mood: PipMood | null = null;
  let outlines: [number, number][][] = [];
  const dots = new Map<string, HTMLElement>();

  const ask = (cmd: UiCmd) => void link.ask(cmd).catch(() => {});
  const reduced = () =>
    root.hasAttribute("data-reduced") ||
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  noticeSounds((cue) => {
    if (chrome?.dock.sounds) sound.play(cue);
  });
  useMenu(link, () => chrome?.dock ?? null);

  const shape = shapeTeller(link, (c) => take(c));
  const keys = keysTeller(link, (c) => take(c));
  const tell = () => shape.tell({ open, hold: panels.holds(), outlines });

  const notch = startNotch(ui, {
    reduced,
    ticker,
    region: (o) => {
      outlines = o;
      tell();
    },
  });

  /** Sends the notch where the view, the pointer and the open panel say. */
  function aim() {
    const c = chrome;
    if (!c) return;
    const high = nav.clientHeight;
    const mid = c.dock.mid > 0 ? c.dock.mid : high / 2;
    const at = { open, mid, high };
    notch.aim({
      ...at,
      dots: c.agents.length,
      wide: nav.clientWidth,
      left: c.dock.edge === "left",
      box: boxFor(c, at, panels.size(), hovered, ui.lip.offsetWidth),
    });
    tell();
  }

  const panels = panelHost({
    host: ui.box,
    keys: keys.tell,
    room: () => panelRoom(nav.clientHeight),
    reduced,
    entering: (e) => notch.entering(e),
    changed: () => {
      const kind = panels.kind();
      attr(ui.inbox, "aria-expanded", String(kind === "inbox"));
      attr(ui.more, "aria-expanded", String(kind === "menu"));
      hover();
      aim();
      // A panel that held the notch open closed while the pointer was elsewhere.
      track();
    },
  });

  function setOpen(want: boolean) {
    if (open === want) return;
    open = want;
    attr(root, "data-open", want ? "" : null);
    // The notch starts moving first, so a dot that slides under the pointer isn't hovered.
    aim();
    hover();
  }

  setNotch(
    (kind: PanelKind, arg?: string) => {
      if (!panelMaker(kind)) return;
      // A notice drops out of the tab as it is; anything else opens the column with it.
      if (kind !== "notice") setOpen(true);
      panels.show(kind, arg);
    },
    () => panels.close(),
  );

  /** Opens `kind`, or closes it when it is open; does `otherwise` until its panel is in. */
  const toggle = (kind: PanelKind, otherwise?: () => void) => {
    if (panels.kind() === kind) panels.close();
    else if (panelMaker(kind)) {
      setOpen(true);
      panels.show(kind);
    } else otherwise?.();
  };

  /** Whether the notch is drawn under `p`: its outline, a button or a panel. */
  const onNotch = (p: { x: number; y: number } | null) =>
    !!p &&
    !!document
      .elementFromPoint(p.x, p.y)
      ?.closest(".nd-fill, .nd-item, .nd-dot, .nd-box");

  /** The dot under the pointer, by what is drawn there now. */
  const under = (): string | null => {
    if (!pointer) return null;
    const hit = document.elementFromPoint(pointer.x, pointer.y);
    return hit?.closest<HTMLElement>(".nd-dot")?.dataset.id ?? null;
  };

  /** The lip follows the dot under the pointer. */
  function hover(moved = false) {
    const ids = chrome?.agents.map((a) => a.id) ?? [];
    // A dot that slides under a pointer that stays put, as the notch opens, isn't hovered.
    const now = moved || !notch.moving() ? under() : null;
    const next = follow(
      hovered,
      open && !panels.kind() && !drag.dragged(),
      now,
      ids,
    );
    for (const [id, e] of dots) attr(e, "data-hover", next === id ? "" : null);
    if (next === hovered) return;
    hovered = next;
    drawLip(
      ui,
      chrome?.agents.find((a) => a.id === hovered),
    );
    aim();
  }

  /** The notch opens once the pointer has rested on it, and folds once it has been off it. */
  function track(moved = false) {
    if (onNotch(pointer) && !drag.dragged()) {
      window.clearTimeout(leaving);
      leaving = undefined;
      if (!open && dwell === undefined) {
        dwell = window.setTimeout(() => {
          dwell = undefined;
          if (onNotch(pointer) && !drag.dragged()) setOpen(true);
        }, DWELL_MS);
      }
    } else {
      window.clearTimeout(dwell);
      dwell = undefined;
      if (open && leaving === undefined && !panels.holds()) {
        leaving = window.setTimeout(() => {
          leaving = undefined;
          if (!onNotch(pointer) && !panels.holds()) setOpen(false);
        }, LEAVE_MS);
      }
    }
    hover(moved);
  }

  /** Takes a view from Nook: as the answer to the page's own ask, or as an event. */
  function take(c: ChromeView) {
    if (!newerChrome(chrome, c)) return;
    const had = chrome;
    chrome = c;
    // Nook folded the notch itself: the pointer left unseen, or the dock is hiding.
    const folded = !c.dock.open && shape.toldOpen() && !shape.busy();
    if (open && folded && !panels.holds()) {
      pointer = null;
      setOpen(false);
    }
    if (had?.dock.keys && !c.dock.keys && !keys.busy()) panels.lostKeys();
    hear(c);
    draw();
  }

  /** A sound for what changed since the last view, never for the first one it sees. */
  function hear(c: ChromeView) {
    if (document.visibilityState !== "visible") {
      ears.forget();
      return;
    }
    const cue = ears.hear(c.agents, c.dock.feed);
    if (cue && c.dock.sounds) sound.play(cue);
  }

  const dotButton = (id: string) => {
    const b = el("button", "nd-dot");
    b.type = "button";
    b.dataset.id = id;
    b.setAttribute("aria-describedby", ui.lip.id);
    b.append(mark());
    b.addEventListener("click", () => {
      if (chrome)
        ask(
          clickFor(
            chrome,
            chrome.agents.find((a) => a.id === id),
          ),
        );
    });
    return b;
  };

  function draw() {
    const c = chrome;
    if (!c) return;
    applyChrome(c, root);
    attr(root, "data-edge", c.dock.edge === "left" ? "left" : "right");
    keyed(ui.dots, dots, c.agents, dotButton);
    for (const a of c.agents) {
      attr(
        dots.get(a.id) as HTMLElement,
        "aria-label",
        `${a.label}: ${a.line}`,
      );
    }
    const count = badgeText(waitingOf(c.agents));
    attr(ui.badge, "data-n", count);
    text(ui.badge, count ?? "");
    attr(ui.inbox, "aria-label", count ? `Inbox: ${count} waiting` : "Inbox");
    if (c.pip.mood !== mood) {
      mood = c.pip.mood;
      ui.pip.replaceChildren(pipSvg(mood, 22));
    }
    attr(ui.talk, "data-on", mood === "listening" ? "" : null);
    if (hovered)
      drawLip(
        ui,
        c.agents.find((a) => a.id === hovered),
      );
    aim();
    notch.redraw();
    // The dots may have moved under a pointer that stayed still.
    hover();
  }

  ui.inbox.addEventListener("click", () =>
    toggle("inbox", () => ask({ kind: "open_today" })),
  );
  ui.pip.addEventListener("click", () =>
    toggle("chat", () => ask({ kind: "dock_open", page: "conversation" })),
  );
  ui.talk.addEventListener("click", () => ask({ kind: "dock_talk" }));
  ui.more.addEventListener("click", () => toggle("menu"));
  ui.lip.addEventListener("click", () => {
    const page = ui.lip.dataset.page as DockPage | undefined;
    if (page) ask({ kind: "dock_open", page });
  });
  // A click on the tab opens the notch without waiting.
  ui.fill.addEventListener("click", () => {
    if (!drag.dragged()) setOpen(true);
  });
  document.addEventListener("keydown", (e) => {
    panels.key(e);
  });

  const drag = presses({
    nav,
    pressable: [ui.shape, ui.column, ui.dots],
    pressing: () => sound.unlock(),
    changed: () => {
      if (drag.dragged()) setOpen(false);
      track();
    },
    ask,
    menu: () => {
      setOpen(true);
      panels.show("menu");
    },
  });

  const moved = (e: PointerEvent) => {
    drag.moved(e);
    // The browser also says the pointer moved when what's under a still pointer changes.
    const fresh =
      !pointer || pointer.x !== e.clientX || pointer.y !== e.clientY;
    pointer = { x: e.clientX, y: e.clientY };
    if (!drag.dragged()) track(fresh);
  };
  document.addEventListener("pointermove", moved);
  document.addEventListener("pointerover", moved);
  root.addEventListener("pointerleave", () => {
    pointer = null;
    track();
  });
  // The window's size in CSS px changes with the dock's size setting.
  window.addEventListener("resize", () => {
    panels.refit();
    aim();
  });

  /** The tab grows out of the edge, as when the dock first shows. */
  const grow = () => {
    root.setAttribute("data-mount", "");
    afterFirstFrame(() => root.removeAttribute("data-mount"));
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      ears.forget();
      pointer = null;
      setOpen(false);
      notch.jump();
    } else grow();
  });
  link.onState(() => {});
  link.onChrome(take);
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
