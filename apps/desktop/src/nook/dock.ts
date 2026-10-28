// Nook's agent dock in Hearth's app (dock.html): dockView.ts, talking to Nook through Tauri. The
// edge tab's look is dock.css and the open pill's dockPill.css.

import "./nook.css";
import "./dock.css";
import "./dockPill.css";
import { startDock } from "./dockView";
import { tauriLink } from "./link";

startDock({ link: tauriLink });
