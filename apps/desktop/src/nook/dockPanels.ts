// The panel open in the agent dock's notch (notchPanel.ts), as dockView.ts hosts it: one at a time,
// its content placed in the box beside the column, PANEL.pad px in from the box's sides, against
// the column and the box's top, as wide as the panel asks and never taller than the box can hold in
// the window (dockLayout.ts's panelRoom): its element is kept to that, and the panel's root shrinks
// to fit it, its middle scrolling while its header and its field stay (dockColumn.css). The keys it
// asks for go one ask at a time, in order (dockAsk.ts). A panel opened in place of another keeps
// the frame, which morphs to the new size (dockNotch.ts), while the old content leaves over 160 ms
// (120 with less motion). A panel that wants the keyboard asks Nook for it as it opens and lets it
// go as it closes, so Nook hands the foreground back to the app you were in; one that loses it to a
// click elsewhere closes without handing anything back. Esc closes a panel unless its key() used it.

import { el } from "./dockParts";
import {
  type NotchPanel,
  PANEL_MAX,
  type PanelKind,
  panelMaker,
  setCurrentPanel,
} from "./notchPanel";

const LEAVE_MS = 160;
const LEAVE_REDUCED_MS = 120;

interface Open {
  kind: PanelKind;
  panel: NotchPanel;
  el: HTMLElement;
}

export function panelHost({
  host,
  keys: askKeys,
  room,
  reduced,
  entering,
  changed,
}: {
  host: HTMLElement;
  /** Asks Nook for the keyboard, or lets it go (dockAsk.ts's keysTeller). */
  keys: (take: boolean) => void;
  /** The tallest content the box holds in the window now. */
  room: () => number;
  reduced: () => boolean;
  /** The notch brings new content in, or has none to bring. */
  entering: (e: HTMLElement | null) => void;
  /** A panel opened, closed or asked for another size. */
  changed: () => void;
}) {
  let open: Open | null = null;
  /** The dock's window has the keyboard, as this page asked. */
  let keys = false;

  const wide = (p: NotchPanel) =>
    Math.min(PANEL_MAX.wide, Math.max(0, p.size().wide));
  /** Its element as wide as it asks, and no taller than the box holds. */
  const fit = (p: NotchPanel, e: HTMLElement) => {
    e.style.width = `${wide(p)}px`;
    e.style.maxHeight = `${room()}px`;
  };

  /** The open panel's content leaves, and is unmounted once it has. */
  function leave() {
    const was = open;
    if (!was) return;
    open = null;
    was.el.inert = true;
    const ms = reduced() ? LEAVE_REDUCED_MS : LEAVE_MS;
    const from = getComputedStyle(was.el).opacity;
    const fading = was.el.animate([{ opacity: from }, { opacity: 0 }], {
      duration: ms,
      easing: "ease-out",
      fill: "forwards",
    });
    const gone = () => {
      was.panel.unmount();
      was.el.remove();
    };
    fading.finished.then(gone, gone);
  }

  const takeKeys = (want: boolean) => {
    if (want === keys) return;
    keys = want;
    askKeys(want);
  };

  function show(kind: PanelKind, arg?: string): boolean {
    const make = panelMaker(kind);
    if (!make) return false;
    const panel = make(arg);
    leave();
    const e = el("div", "nd-content");
    e.dataset.kind = kind;
    fit(panel, e);
    host.append(e);
    const mine: Open = { kind, panel, el: e };
    open = mine;
    panel.mount(e);
    panel.onResize(() => {
      if (open !== mine) return;
      fit(panel, e);
      changed();
    });
    panel.onClose?.(() => {
      if (open === mine) close();
    });
    takeKeys(panel.wantsKeys);
    entering(e);
    changed();
    return true;
  }

  /** Closes the open panel, and lets the keyboard go, handing it back unless it was taken. */
  function close(giveBack = true) {
    if (!open) return;
    leave();
    entering(null);
    if (keys) {
      keys = false;
      if (giveBack) askKeys(false);
    }
    changed();
  }

  setCurrentPanel(() => open?.kind ?? null);

  return {
    show,
    close,
    /** The open panel's kind, or null. */
    kind: (): PanelKind | null => open?.kind ?? null,
    /** The open panel's room, as it asks for it, no taller than the box holds. */
    size: () =>
      open
        ? {
            ...open.panel.size(),
            tall: Math.min(open.panel.size().tall, room()),
          }
        : null,
    /** The window changed size: the open panel's element is kept to the new room. */
    refit() {
      if (open) fit(open.panel, open.el);
    },
    /** A panel that has the keyboard holds the notch open wherever the pointer goes. */
    holds: () => !!open?.panel.wantsKeys,
    /** Nook says the dock's window lost the keyboard: to a click elsewhere, so nothing is handed
     * back. */
    lostKeys() {
      if (keys && open?.panel.wantsKeys) {
        keys = false;
        close(false);
      }
    },
    /** A key while a panel is open: true when it was used. */
    key(e: KeyboardEvent): boolean {
      if (!open) return false;
      if (open.panel.key?.(e)) return true;
      if (e.key !== "Escape") return false;
      e.preventDefault();
      close();
      return true;
    },
  };
}

export type PanelHost = ReturnType<typeof panelHost>;
