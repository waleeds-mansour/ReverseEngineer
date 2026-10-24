// Smoke steps for writing a note the way a person does (Notes, live markdown), run from smoke.ts:
// the / menu makes a heading and a checklist, double-clicking a word and the bar's Bold make it
// bold, Ctrl+I italic, and the marks hide once you're off their line. The Markdown button shows
// them again, and what's saved is plain markdown.
import type { Page } from "playwright";

interface Smoke {
  step: (name: string, fn: (p: Page) => Promise<void>) => Promise<void>;
  keys: (...k: string[]) => Promise<void>;
  base: string;
  tag: string;
}

/**
 * The middle of a word on screen in the note, to double-click as a person would. Written as text:
 * it runs in the page, and this file is typed without the browser's globals.
 */
const wordAt = (p: Page, word: string) =>
  p.evaluate<{ x: number; y: number }>(`(() => {
    const word = ${JSON.stringify(word)};
    const note = document.querySelector(".cm-content");
    const walk = document.createTreeWalker(note, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const i = n.textContent.indexOf(word);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + word.length);
      const b = r.getBoundingClientRect();
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    throw new Error("no " + word + " in the note");
  })()`);

/** The note's markdown as saved, once it has every line in `want`. */
async function savedBody(p: Page, want: string[]) {
  const id = new URL(p.url()).pathname.split("note/")[1]!.split("+")[0]!;
  let body = "";
  for (let i = 0; i < 40; i++) {
    body = await p.evaluate(async (id) => {
      const r = await fetch("/api/actions/entity.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const j = (await r.json()) as { result?: { body?: string | null } };
      return j.result?.body ?? "";
    }, id);
    if (want.every((line) => body.split("\n").includes(line))) return body;
    await p.waitForTimeout(250);
  }
  throw new Error(`the note saved as ${JSON.stringify(body)}`);
}

export async function noteSteps({ step, keys, base, tag }: Smoke) {
  await step(
    "a note written with the / menu and the bar, its marks hidden off their line",
    async (p) => {
      await p.goto(`${base}/notes`);
      await p.getByRole("button", { name: "New note" }).click();
      const title = p.locator("input[placeholder=Untitled]");
      await title.fill(`Trip plan ${tag}`);
      await title.press("Enter");
      const editor = p.locator(".cm-content");
      await editor.click();
      const menu = p.locator(".cm-tooltip-autocomplete");
      await p.keyboard.type("/");
      await menu.locator("li", { hasText: "Heading 1" }).click();
      await p.keyboard.type("Packing");
      await keys("Enter");
      await p.keyboard.type("Book flights and the hotel");
      let at = await wordAt(p, "flights");
      await p.mouse.dblclick(at.x, at.y);
      await p
        .getByRole("toolbar", { name: "Format" })
        .getByRole("button", { name: /^Bold/ })
        .click();
      await keys("End", "Enter");
      await p.keyboard.type("/check");
      await menu.locator("li", { hasText: "Checklist" }).click();
      await p.keyboard.type("passport");
      // Enter carries the checklist on to the next line.
      await keys("Enter");
      await p.keyboard.type("charger");
      at = await wordAt(p, "charger");
      await p.mouse.dblclick(at.x, at.y);
      await keys("Control+i");
      // Out of the note: the bar goes, and no line shows its marks.
      await title.click();
      await p.getByRole("toolbar", { name: "Format" }).waitFor({ state: "detached" });
      await editor.locator(".cm-md-h1", { hasText: "Packing" }).waitFor();
      await editor.locator(".cm-md-strong", { hasText: "flights" }).waitFor();
      await editor.locator(".cm-md-em", { hasText: "charger" }).waitFor();
      if ((await editor.locator("input[type=checkbox]").count()) !== 2)
        throw new Error("the checklist has no boxes");
      const shown = await editor.innerText();
      if (/\*|#|\[ \]|^- /m.test(shown)) throw new Error(`markdown showing: ${shown}`);
      await savedBody(p, [
        "# Packing",
        "Book **flights** and the hotel",
        "- [ ] passport",
        "- [ ] *charger*",
      ]);
    },
  );

  await step(
    "the Markdown button shows every mark, and the note reads the same after a reload",
    async (p) => {
      await p.reload();
      const editor = p.locator(".cm-content");
      await editor.getByText("Packing").waitFor();
      const markdown = p.getByRole("button", { name: "Markdown" });
      await markdown.click();
      await editor.getByText("# Packing").waitFor();
      await editor.getByText("**flights**").waitFor();
      // Back off for the steps after this one: the button is remembered.
      await markdown.click();
      await editor.getByText("**flights**").waitFor({ state: "detached" });
    },
  );
}
