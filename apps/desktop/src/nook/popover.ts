// The Nook bar's popover in Hearth's app (popover.html): popoverView.ts, talking to Nook
// through Tauri.

import "./nook.css";
import "./popover.css";
import { tauriLink } from "./link";
import { startPopover } from "./popoverView";

startPopover({ link: tauriLink });
