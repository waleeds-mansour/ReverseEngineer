// Nook's agent dock in Hearth's app (dock.html): dockView.ts, talking to Nook through Tauri. The
// notch's look is dock.css and dockColumn.css; panels.ts brings in every panel it can hold.

import "./nook.css";
import "./dock.css";
import "./dockColumn.css";
import "./panels";
import { startDock } from "./dockView";
import { tauriLink } from "./link";

startDock({ link: tauriLink });
