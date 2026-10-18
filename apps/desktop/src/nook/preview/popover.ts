// The dev-only preview of the Nook bar's popover, fed by fixture.ts.

import "../nook.css";
import "../popover.css";
import "./preview.css";
import { startPopover } from "../popoverView";
import { fakeLink } from "./fixture";

startPopover({ link: fakeLink });
