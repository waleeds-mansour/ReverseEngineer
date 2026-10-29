// What opens inside the agent dock's notch, and how (L2-20 on the Decision Tree). The notch is one
// black shape on the screen's edge: a tab at rest, a column of icons when hovered, and grown wider
// and taller to hold a panel: the Inbox, a notice of something new, the chat with Pip, or the
// dock's own menu. A panel draws only its content, in CSS px at 1x on the notch's black, and the
// page's zoom (the dock's size setting) scales it with everything else. The notch places it,
// morphs its outline around it, gives it the keyboard when it asks, and closes it on Esc unless the
// panel used the key.
//
// Each panel's module registers its maker when panels.ts imports it, so the notch opens a kind
// only once that kind's module is in, and a panel can open another (a notice opening the Inbox at
// its card) through openPanel without importing the notch.

/** The kinds of panel the notch holds. */
export type PanelKind = "inbox" | "notice" | "chat" | "menu";

/** Its room inside the notch, in CSS px at 1x. */
export interface PanelSize {
  wide: number;
  tall: number;
  /** The black round it on every side, PANEL_PAD unless it says: a notice keeps less. */
  pad?: number;
}

/** The biggest panel the notch holds, so the dock's window is made once, at that size. */
export const PANEL_MAX: PanelSize = { wide: 420, tall: 640 };

/** The black the notch keeps round a panel's element on every side, outside size(). */
export const PANEL_PAD = 16;

export interface NotchPanel {
  readonly kind: PanelKind;
  /**
   * It takes the keyboard while open: Nook activates the dock's window then, and hands the
   * foreground back to the app you were in when it closes.
   */
  readonly wantsKeys: boolean;
  /** The room it wants, at most PANEL_MAX. */
  size(): PanelSize;
  /** Draws into `el`, which the notch has placed and padded. */
  mount(el: HTMLElement): void;
  unmount(): void;
  /** A key while it is open; true when used. Esc closes the panel otherwise. */
  key?(e: KeyboardEvent): boolean;
  /** The notch listens here, and morphs again whenever size() changes. */
  onResize(cb: () => void): void;
  /** The notch listens here for the panel asking to close: a notice after its time, a ×. */
  onClose?(cb: () => void): void;
}

/** Makes a panel of a kind, for what it opens on: a card's id, a conversation's, or nothing. */
export type PanelMaker = (arg?: string) => NotchPanel;

const makers = new Map<PanelKind, PanelMaker>();

/** Called by each panel's module as panels.ts imports it. */
export function registerPanel(kind: PanelKind, make: PanelMaker): void {
  makers.set(kind, make);
}

/** The maker for a kind, if its module is in. */
export function panelMaker(kind: PanelKind): PanelMaker | undefined {
  return makers.get(kind);
}

type Opener = (kind: PanelKind, arg?: string) => void;

let opener: Opener = () => {};
let closer: () => void = () => {};

/** The notch hands over how it opens and closes panels when it starts. */
export function setNotch(open: Opener, close: () => void): void {
  opener = open;
  closer = close;
}

/** Opens a panel of `kind` in the notch, in place of any panel open, or does nothing before the
 * notch has started. */
export function openPanel(kind: PanelKind, arg?: string): void {
  opener(kind, arg);
}

/** Closes the open panel; the notch folds back to its column, or to the tab if the pointer left. */
export function closePanel(): void {
  closer();
}

let current: () => PanelKind | null = () => null;

/** The notch also says which panel is open, however it opened or closed. */
export function setCurrentPanel(get: () => PanelKind | null): void {
  current = get;
}

/** The kind of panel open in the notch, or null: a notice keeps away from a panel you're in. */
export function openKind(): PanelKind | null {
  return current();
}
