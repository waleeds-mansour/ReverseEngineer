// The dev-only preview of the Nook bar, fed by fixture.ts.

import "../nook.css";
import "../bar.css";
import "./preview.css";
import { startBar } from "../barView";
import { fakeLink, fixedNow } from "./fixture";

startBar({ link: fakeLink, now: fixedNow, ticks: false });
