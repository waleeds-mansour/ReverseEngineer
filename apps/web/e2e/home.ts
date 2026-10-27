// Where Hearth opens: Today, its pane headed "Today". Every suite waits on it after signing in or
// coming back, so the screen Hearth opens on is named in one place.
import type { Page } from "playwright";

export const home = (p: Page) => p.getByRole("heading", { name: "Today", exact: true, level: 1 });

/** Takes the focus off whatever has it (a box, an editor), so Hearth's keys (g n) work again. */
export const letGo = (p: Page) => p.evaluate("document.activeElement?.blur()");
