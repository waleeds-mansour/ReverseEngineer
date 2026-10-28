// The dev-only preview of Nook's agent dock, fed by fixture.ts. The page stands in for the screen:
// the dock's window is framed at its right edge (or left, with &edge=left), as big as Nook makes
// it, at rest and once it has made room for the open pill, so what doesn't fit the window is cut
// off here as it is there. &bezel=1 puts the black bezel beyond that edge, which the tab merges
// with, and &frame=1 outlines the window. Rest on the tab to open the pill, and on a dot for its
// label.

import "../nook.css";
import "../dock.css";
import "../dockPill.css";
import "./preview.css";
import type { Link } from "../link";
import { windowSize } from "../dockShape";
import { startDock } from "../dockView";
import { chrome, fakeLink } from "./fixture";

const root = document.documentElement;
const q = new URLSearchParams(location.search);
if (q.get("bezel") === "1") root.setAttribute("data-bezel", "");
if (q.get("frame") === "1") root.setAttribute("data-frame", "");

/** Sizes the window as Nook would for the view it is about to hand the page. */
const frame = () => {
  const [w, h] = windowSize(chrome.agents.length, chrome.dock.open);
  root.style.setProperty("--frame-w", `${w}px`);
  root.style.setProperty("--frame-h", `${h}px`);
};
frame();

const link: Link = {
  ...fakeLink,
  ask: async (cmd) => {
    const reply = await fakeLink.ask(cmd);
    frame();
    return reply;
  },
};

startDock({ link });
