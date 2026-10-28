// The quick-ask box in Hearth's app (ask.html): askView.ts, talking to Hearth through Tauri.

import "./nook.css";
import "./ask.css";
import { startAsk, tauriAsk } from "./askView";

startAsk({ link: tauriAsk });
