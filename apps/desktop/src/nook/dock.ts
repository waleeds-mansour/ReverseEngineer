// Nook's agent dock in Hearth's app (dock.html): dockView.ts, talking to Nook through Tauri.

import "./nook.css";
import "./dock.css";
import { startDock } from "./dockView";
import { tauriLink } from "./link";

startDock({ link: tauriLink });
