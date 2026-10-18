// The Nook bar's popover (docs/nook-wm.md, "WINDOWS"): what Pip is doing, how Hearth's services
// are, and a way into Hearth. Rust keeps it made, hidden and suspended until the bar asks for it,
// and closes it when another app comes to the front. Muted text lives here, not on the bar.

import type { ChromeView, Health } from "@/bindings";
import { applyChrome, bootTheme } from "./chrome";
import { chromeCopy, doing, health } from "./chromeCopy";
import { afterFirstFrame, type Link, newerChrome } from "./link";
import { pipSvg } from "./pip";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text = "",
) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const tone = (h: Health) =>
  h === "ok" ? "ok" : h === "down" ? "bad" : h === "trouble" ? "warn" : "quiet";

export function startPopover({ link }: { link: Link }) {
  const root = document.documentElement;
  bootTheme(root);
  const card = document.getElementById("pop") as HTMLElement;

  const head = el("div", "np-pip");
  const art = el("span", "np-art");
  const words = el("div", "np-words");
  const name = el("strong", "", chromeCopy.pip);
  const status = el("span", "re-caption np-status");
  words.append(name, status);
  head.append(art, words);

  const title = el("p", "re-overline np-title", chromeCopy.servicesTitle);
  const rows = el("dl", "np-rows");
  const row = (label: string) => {
    const r = el("div", "np-row");
    const value = el("dd", "");
    r.append(el("dt", "", label), value);
    rows.append(r);
    return value;
  };
  const server = row(chromeCopy.server);
  const worker = row(chromeCopy.worker);
  const pip = row(chromeCopy.pip);
  const failing = el("p", "np-failing", chromeCopy.otherFailing);
  const open = el(
    "button",
    "re-btn re-btn--primary re-btn--sm np-open",
    chromeCopy.openToday,
  );
  open.type = "button";
  card.append(head, el("div", "re-sep"), title, rows, failing, open);

  let chrome: ChromeView | null = null;
  let drawnMood = "";
  const value = (dd: HTMLElement, h: Health, words = health[h]) => {
    if (dd.textContent !== words) dd.textContent = words;
    dd.dataset.tone = tone(h);
  };
  const draw = () => {
    if (!chrome) return;
    applyChrome(chrome, root);
    const { mood, waiting } = chrome.pip;
    if (mood !== drawnMood) {
      art.replaceChildren(pipSvg(mood, 40));
      drawnMood = mood;
    }
    status.textContent =
      waiting > 0 ? chromeCopy.waiting(waiting) : doing[mood];
    const s = chrome.services;
    value(server, s.server);
    value(worker, s.worker);
    value(pip, s.pip, s.pip_paused ? chromeCopy.paused : health[s.pip]);
    failing.hidden = !s.other_failing;
  };

  open.addEventListener("click", () => void link.ask({ kind: "open_today" }));
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
