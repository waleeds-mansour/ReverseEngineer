// The Nook bar's page in Hearth's app (bar.html): barView.ts, talking to Nook through Tauri.

import "./nook.css";
import "./bar.css";
import { startBar } from "./barView";
import { tauriLink } from "./link";

startBar({ link: tauriLink });
