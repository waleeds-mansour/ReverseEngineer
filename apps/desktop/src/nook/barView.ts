// The Nook bar's page (docs/nook-wm.md, "CONTENT" and "PIP IN THE BAR"), left to right: the app
// in front in bold, a spacer, Hearth's services, Pip, and the clock. While Pip works, the island
// grows out of Pip's chip inside the bar. It draws only when something it shows changes: the
// clock keeps one timer aligned to the minute, Pip holds still at idle, and Pip's moving poses
// stop 30 s after the last change. The page asks Nook for nothing but its state, to be shown
// once its first frame is drawn, and to open or close the popover.

import type { ChromeView, NookState, PipMood } from "@/bindings";
import { applyChrome, bootTheme, pauseWhileHidden } from "./chrome";
import {
  chromeCopy,
  clockText,
  doing,
  servicesLine,
  untilNextMinute,
} from "./chromeCopy";
import { afterFirstFrame, type Link, newer, newerChrome } from "./link";
import { pipSvg } from "./pip";

/** How long Pip's working poses may move without a new state (docs/nook-wm.md). */
export const STILL_AFTER_MS = 30_000;

export interface BarOptions {
  link: Link;
  /** The clock's time; the preview fixes it. */
  now?: () => Date;
  /** The preview's fixed clock never ticks. */
  ticks?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string) {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

/** Sets text only when it differs, so an unchanged state lays out and paints nothing. */
function text(e: Element, value: string) {
  if (e.textContent !== value) e.textContent = value;
}

function attr(e: Element, name: string, value: string | null) {
  if (value === null) {
    if (e.hasAttribute(name)) e.removeAttribute(name);
  } else if (e.getAttribute(name) !== value) e.setAttribute(name, value);
}

const working = (m: PipMood) => m === "listening" || m === "thinking";

export function startBar({
  link,
  now = () => new Date(),
  ticks = true,
}: BarOptions) {
  const root = document.documentElement;
  bootTheme(root);
  pauseWhileHidden(root);
  const bar = document.getElementById("bar") as HTMLElement;
  const app = el("span", "item nb-app");
  const grow = el("span", "grow");
  const services = el("button", "re-badge nb-services");
  services.type = "button";
  const servicesDot = el("i", "");
  const servicesText = el("span", "");
  services.append(servicesDot, servicesText);
  const pip = el("button", "nb-pip");
  pip.type = "button";
  const pipArt = el("span", "nb-pip-art");
  const pipName = el("span", "nb-pip-name");
  const more = el("span", "nb-more");
  const phrase = el("span", "nb-phrase");
  const keys = el("span", "nb-keys");
  const waitDot = el("span", "nb-wait");
  more.append(phrase, keys);
  pip.append(pipArt, pipName, more, waitDot);
  const clock = el("span", "item nb-clock");
  bar.append(app, grow, services, pip, clock);
  text(pipName, chromeCopy.pip);

  let state: NookState | null = null;
  let chrome: ChromeView | null = null;
  let drawnMood: PipMood | null = null;
  let stillTimer: number | undefined;

  const drawState = () => {
    const name = state?.mode === "observing" ? (state.focused?.app ?? "") : "";
    text(app, name);
  };

  const drawPip = (c: ChromeView) => {
    const { mood, waiting, stop_key } = c.pip;
    if (mood !== drawnMood) {
      pipArt.replaceChildren(pipSvg(mood, working(mood) ? 24 : 20));
      drawnMood = mood;
      // Moving poses stop 30 s after Pip's last change, and idle never moves.
      delete root.dataset.still;
      window.clearTimeout(stillTimer);
      if (working(mood)) {
        stillTimer = window.setTimeout(() => {
          root.dataset.still = "";
        }, STILL_AFTER_MS);
      }
    }
    attr(pip, "data-working", working(mood) ? "" : null);
    attr(pip, "data-waiting", waiting > 0 ? "" : null);
    attr(pip, "aria-label", chromeCopy.pipLabel(mood, waiting));
    attr(pip, "aria-expanded", c.bar.popover ? "true" : "false");
    text(phrase, working(mood) ? doing[mood] : "");
    const caps = working(mood) ? stop_key : [];
    if (
      keys.childElementCount !== caps.length ||
      keys.textContent !== caps.join("")
    ) {
      keys.replaceChildren(
        ...caps.map((k) => {
          const kbd = el("kbd", "re-kbd");
          kbd.textContent = k;
          return kbd;
        }),
      );
    }
  };

  const drawChrome = () => {
    if (!chrome) return;
    applyChrome(chrome, root);
    const line = servicesLine(chrome.services);
    const cls = `re-badge nb-services${line.tone === "quiet" ? "" : ` re-badge--${line.tone}`}`;
    if (services.className !== cls) services.className = cls;
    attr(services, "aria-expanded", chrome.bar.popover ? "true" : "false");
    // A game or something fullscreen on another monitor: the bar stays, and nothing moves.
    attr(root, "data-quiet", chrome.bar.quiet ? "" : null);
    text(servicesText, line.text);
    drawPip(chrome);
  };

  const tick = () => {
    text(clock, clockText(now()));
    if (ticks) window.setTimeout(tick, untilNextMinute(now()));
  };

  const toggle = () => {
    void link.ask({ kind: "popover", open: !(chrome?.bar.popover ?? false) });
  };
  services.addEventListener("click", toggle);
  pip.addEventListener("click", toggle);

  link.onState((s) => {
    if (newer(state, s)) {
      state = s;
      drawState();
    }
  });
  link.onChrome((c) => {
    if (newerChrome(chrome, c)) {
      chrome = c;
      drawChrome();
    }
  });
  // Rust suspends the page while it is hidden; awake again, the clock may be behind.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") text(clock, clockText(now()));
  });

  tick();
  void link.ask({ kind: "ready" }).then((reply) => {
    if (newer(state, reply.state)) state = reply.state;
    if (newerChrome(chrome, reply.chrome)) chrome = reply.chrome;
    drawState();
    drawChrome();
    afterFirstFrame(() => void link.ask({ kind: "drawn" }));
  });
}
