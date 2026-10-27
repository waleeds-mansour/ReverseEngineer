// The dev-only preview of Nook's agent dock, fed by fixture.ts. Hover a dot for its card.

import "../nook.css";
import "../dock.css";
import "./preview.css";
import { startDock } from "../dockView";
import { fakeLink } from "./fixture";

startDock({ link: fakeLink });
