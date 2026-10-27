// Smoke steps for writing a note the way a person does (Notes, live markdown), run from smoke.ts:
// the / menu makes a heading and a checklist, double-clicking a word and the bar's Bold make it
// bold, Ctrl+I italic, and the marks hide once you're off their line. The Markdown button shows
// them again, and what's saved is plain markdown. A pasted picture shows in the note, a table made
// with /table and filled in with Tab and Enter is a grid, and a line that's a link is a card.
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

  await step(
    "a pasted picture, a table filled in with Tab and Enter, and a link card, kept after a reload",
    async (p) => {
      await p.goto(`${base}/notes`);
      await p.getByRole("button", { name: "New note" }).click();
      const title = p.locator("input[placeholder=Untitled]");
      await title.fill(`Beach ${tag}`);
      await title.press("Enter");
      const editor = p.locator(".cm-content");
      await editor.click();
      await p.keyboard.type("Beach day");
      await keys("Enter");
      await pastePicture(p);
      // Nothing's in the note until Nook has it; then the picture, drawn, under the caret's line.
      await pictureShows(p);
      await p.keyboard.type("/table");
      await p.locator(".cm-tooltip-autocomplete li", { hasText: "Table" }).click();
      await p.keyboard.type("Item");
      await keys("Tab");
      await p.keyboard.type("Qty");
      await keys("Tab");
      await p.keyboard.type("towels");
      await keys("Tab");
      await p.keyboard.type("2");
      await keys("Enter");
      await p.keyboard.type("sunscreen");
      await keys("Tab");
      await p.keyboard.type("1");
      // Enter adds a row; Enter on that empty row leaves the table.
      await keys("Enter", "Enter");
      await p.keyboard.type("https://example.com");
      await title.click();
      const grid = editor.locator(".cm-note-grid");
      await grid.locator("td", { hasText: "sunscreen" }).waitFor();
      await editor.locator(".cm-note-card", { hasText: "example.com" }).waitFor();
      // A click on a cell puts the caret in it, to edit; off the table it's a grid again.
      await grid.locator("td", { hasText: "2" }).click();
      await editor.locator(".cm-md-table").first().waitFor();
      await p.keyboard.type("0");
      await title.click();
      await grid.locator("td", { hasText: "20" }).waitFor();
      const body = await savedBody(p, [
        "Beach day",
        "| Item | Qty |",
        "| --- | --- |",
        "| towels | 20 |",
        "| sunscreen | 1 |",
        "https://example.com",
      ]);
      if (!/^!\[Pasted image [^\]]+\]\(\/api\/files\/[0-9a-f-]{36}\)$/m.test(body))
        throw new Error(`no picture in the note: ${body}`);
      await p.reload();
      await editor.locator(".cm-note-grid td", { hasText: "towels" }).waitFor();
      await editor.locator(".cm-note-card", { hasText: "example.com" }).waitFor();
      await pictureShows(p);
    },
  );
}

/** Pastes a small picture into the note, as a screenshot is pasted. */
const pastePicture = (p: Page) =>
  p.evaluate(`(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const g = canvas.getContext("2d");
    g.fillStyle = "#3b82f6";
    g.fillRect(0, 0, 160, 90);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "image.png", { type: "image/png" }));
    const paste = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
    document.querySelector(".cm-content").dispatchEvent(paste);
  })()`);

/** The note shows a picture kept in Nook, loaded. */
async function pictureShows(p: Page) {
  const img = p.locator(".cm-note-picture img");
  await img.waitFor();
  await p.waitForFunction(
    `(() => { const i = document.querySelector(".cm-note-picture img"); return i && i.complete && i.naturalWidth === 160; })()`,
  );
}
