// The agent dock's own menu, as a panel in its notch (notchPanel.ts), opened by "…" or a right
// click anywhere on the dock: move it to the other edge, hide it for an hour, its sounds, its size,
// Nook's settings for it, and turning it off. Nook carries each out (UiCmd::DockChoose), and the
// menu closes. It takes the keyboard while open: Up and Down move between rows, Left and Right
// between the sizes, Enter chooses, and Esc closes it, as the notch does for any panel.

import "./menuPanel.css";
import type { DockChoice, DockView, UiCmd } from "@/bindings";
import { attr, el, text } from "./dockParts";
import { tauriLink } from "./link";
import { type NotchPanel, registerPanel } from "./notchPanel";

/** The sizes the dock comes in: docksize.rs's SCALES. */
export const SIZES = [100, 125, 150, 175] as const;
/** The panel's room, in CSS px at 1x. */
export const MENU_WIDE = 236;

/** A row of the menu: what it says, and what choosing it asks of Nook. */
export interface MenuRow {
  id: string;
  label: string;
  /** Sounds' tick, while they are on. */
  checked?: boolean;
  choice: DockChoice;
  /** A line above it, between groups. */
  apart?: boolean;
}

/** The menu's rows for the dock as Nook last showed it. Size is its own row (SIZES). */
export function menuRows(dock: Pick<DockView, "edge" | "sounds">): MenuRow[] {
  const to = dock.edge === "left" ? "right" : "left";
  return [
    {
      id: "edge",
      label: `Move to the ${to} edge`,
      choice: { kind: "edge", edge: to },
    },
    { id: "rest", label: "Hide for an hour", choice: { kind: "rest" } },
    {
      id: "sounds",
      label: "Sounds",
      checked: dock.sounds,
      choice: { kind: "sounds", on: !dock.sounds },
      apart: true,
    },
    {
      id: "settings",
      label: "Dock settings…",
      choice: { kind: "settings" },
      apart: true,
    },
    { id: "off", label: "Turn off the dock", choice: { kind: "off" } },
  ];
}

/** Where the size row sits among the rows: after Sounds. */
const SIZE_AT = 3;

/** The row and size the keyboard is on after `key`, from `row` and `size` of `rows` rows. */
export function moveIn(
  key: string,
  row: number,
  size: number,
  rows: number,
): { row: number; size: number } | null {
  switch (key) {
    case "ArrowDown":
      return { row: (row + 1) % rows, size };
    case "ArrowUp":
      return { row: (row - 1 + rows) % rows, size };
    case "ArrowRight":
      return row === SIZE_AT
        ? { row, size: Math.min(SIZES.length - 1, size + 1) }
        : null;
    case "ArrowLeft":
      return row === SIZE_AT ? { row, size: Math.max(0, size - 1) } : null;
    case "Home":
      return { row: 0, size };
    case "End":
      return { row: rows - 1, size };
    default:
      return null;
  }
}

let link: { ask(cmd: UiCmd): Promise<unknown> } = tauriLink;
let view: () => DockView | null = () => null;

/** The notch says where the menu asks and what the dock is now; the preview's link, in its page. */
export function useMenu(
  to: { ask(cmd: UiCmd): Promise<unknown> },
  dock: () => DockView | null,
): void {
  link = to;
  view = dock;
}

export function menuPanel(): NotchPanel {
  const dock = view();
  const rows = menuRows(dock ?? { edge: "right", sounds: true });
  const scale = dock?.scale ?? 150;
  const root = el("div", "nm");
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", "Dock");
  const items: HTMLElement[] = [];
  const sizes: HTMLButtonElement[] = [];
  let closers: (() => void)[] = [];
  let row = 0;
  let size = Math.max(0, SIZES.indexOf(scale as (typeof SIZES)[number]));

  const choose = (choice: DockChoice) => {
    void link.ask({ kind: "dock_choose", choice }).catch(() => {});
    for (const cb of closers) cb();
  };

  for (const r of rows) {
    if (r.id === "settings") {
      const line = el("div", "nm-row nm-size");
      line.setAttribute("role", "group");
      line.setAttribute("aria-label", "Size");
      const name = el("span", "nm-label");
      text(name, "Size");
      const seg = el("span", "nm-seg");
      SIZES.forEach((percent, i) => {
        const b = el("button", "nm-pick");
        b.type = "button";
        b.setAttribute("role", "menuitemradio");
        b.setAttribute("aria-checked", String(percent === scale));
        text(b, `${percent}`);
        b.addEventListener("click", () => choose({ kind: "size", percent }));
        b.addEventListener("pointerenter", () => go(SIZE_AT, i));
        sizes.push(b);
        seg.append(b);
      });
      line.append(name, seg);
      items.push(line);
      root.append(line);
    }
    if (r.apart) root.append(el("hr", "nm-apart"));
    const b = el("button", "nm-row");
    b.type = "button";
    b.setAttribute(
      "role",
      r.checked === undefined ? "menuitem" : "menuitemcheckbox",
    );
    if (r.checked !== undefined)
      b.setAttribute("aria-checked", String(r.checked));
    const label = el("span", "nm-label");
    text(label, r.label);
    const tick = el("span", "nm-tick");
    tick.setAttribute("aria-hidden", "true");
    text(tick, r.checked ? "✓" : "");
    b.append(label, tick);
    b.addEventListener("click", () => choose(r.choice));
    const at = items.length;
    b.addEventListener("pointerenter", () => go(at, size));
    items.push(b);
    root.append(b);
  }

  /** Puts the keyboard's mark on row `r`, and on size `s` while that row is the sizes. */
  function go(r: number, s: number) {
    row = r;
    size = s;
    items.forEach((e, i) => attr(e, "data-at", i === row ? "" : null));
    sizes.forEach((e, i) =>
      attr(e, "data-at", row === SIZE_AT && i === size ? "" : null),
    );
  }

  return {
    kind: "menu",
    wantsKeys: true,
    size: () => ({
      wide: MENU_WIDE,
      tall: Math.ceil(root.offsetHeight) || 7 * 34 + 2 * 9,
    }),
    mount(host) {
      host.append(root);
      go(0, size);
    },
    unmount() {
      root.remove();
      closers = [];
    },
    key(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (row === SIZE_AT) choose({ kind: "size", percent: SIZES[size] });
        else (items[row] as HTMLButtonElement).click();
        return true;
      }
      const next = moveIn(e.key, row, size, items.length);
      if (!next) return false;
      e.preventDefault();
      go(next.row, next.size);
      return true;
    },
    onResize() {},
    onClose(cb) {
      closers.push(cb);
    },
  };
}

registerPanel("menu", () => menuPanel());
