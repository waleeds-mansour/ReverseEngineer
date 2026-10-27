// Smoke steps for Today as Pip's feed and the window around it (tabs on top, Pip's bar at the
// bottom), run from smoke.ts right after signing in.
import type { Page } from "playwright";
import { home } from "./home.ts";

interface Smoke {
  step: (name: string, fn: (p: Page) => Promise<void>) => Promise<void>;
  keys: (...k: string[]) => Promise<void>;
}

export async function todaySteps({ step, keys }: Smoke) {
  await step(
    "Today is Pip's feed, at full width, with Pip's bar to open and put away",
    async (p) => {
      // Pip says how the day looks; its feed has what it did, and your day beside it.
      await p.getByRole("heading", { name: /^Good (morning|afternoon|evening)\. / }).waitFor();
      for (const name of ["What I did", "Your day", "Due"])
        await p.getByRole("heading", { name, exact: true }).waitFor();
      await p.getByRole("button", { name: "Plan my day" }).waitFor();
      // Nothing sits beside the page: no sidebar, no Pip panel.
      const wide = (await p.locator("main").boundingBox())?.width ?? 0;
      if (wide < 1439) throw new Error(`the page is squeezed to ${wide} px`);
      // Pip's bar opens your conversation over the page, and Esc puts it away again.
      const bar = p.getByRole("form", { name: "Pip" });
      const pip = p.getByRole("complementary", { name: "Pip" });
      await bar.getByRole("button", { name: "Open Pip" }).click();
      await pip.locator("textarea").waitFor();
      await keys("Escape");
      await pip.waitFor({ state: "detached" });
      // / puts you in the bar; Ctrl+J opens the conversation and puts it away.
      await keys("/");
      // A string is run as an expression (a function in a string never runs), so it reads the name.
      const at = await p.evaluate("document.activeElement?.getAttribute('aria-label')");
      if (at !== "Ask Pip or add a task") throw new Error(`/ put you in ${at}, not Pip's bar`);
      await keys("Escape", "Control+j");
      await pip.waitFor();
      await keys("Control+j");
      await pip.waitFor({ state: "detached" });
      // Pages are the window's: the page under Pip is still Today.
      await home(p).waitFor();
    },
  );
}
