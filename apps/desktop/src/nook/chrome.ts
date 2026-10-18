// How Nook's pages take a chrome view (docs/nook-wm.md, "THEME" and "GLASS"): data-theme picks
// one of nook.css's six themes and crossfades to it over dur-base, data-glass says DWM's acrylic
// is behind the page (otherwise it draws a solid surface), and data-reduced stops every
// animation when Windows' animation effects are off. The page's own prefers-reduced-motion
// stops them too, in nook.css.

import type { ChromeView, ThemeId } from "@/bindings";

/** dur-base in design/nook/tokens.json. */
export const DUR_BASE_MS = 220;

const reducedByPage = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Before the first view comes: the system's light or dark, as Hearth's own pages start. */
export function bootTheme(root: HTMLElement = document.documentElement): void {
  if (root.dataset.theme) return;
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "dark" : "light";
}

let fading: number | undefined;

export function applyChrome(
  view: ChromeView,
  root: HTMLElement = document.documentElement,
): void {
  const reduced = view.reduced_motion || reducedByPage();
  const theme: ThemeId = view.theme;
  if (root.dataset.theme !== theme) {
    if (!reduced && root.dataset.theme) {
      root.dataset.themeFade = "";
      window.clearTimeout(fading);
      fading = window.setTimeout(() => {
        delete root.dataset.themeFade;
      }, DUR_BASE_MS);
    }
    root.dataset.theme = theme;
  }
  root.toggleAttribute("data-glass", view.glass);
  root.toggleAttribute("data-reduced", view.reduced_motion);
}

/** Animations pause while the page isn't on screen, though Rust suspends a hidden bar anyway. */
export function pauseWhileHidden(
  root: HTMLElement = document.documentElement,
): void {
  document.addEventListener("visibilitychange", () => {
    root.toggleAttribute("data-hidden", document.visibilityState !== "visible");
  });
}
