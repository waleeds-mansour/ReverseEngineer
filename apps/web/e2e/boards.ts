// Smoke steps for the canvas and spreadsheets (M7), run from smoke.ts.
import type { Page } from "playwright";

type Saved = {
  title: string;
  version: number;
  book: {
    sheets: {
      cells: Record<string, string>;
      formats: Record<string, Record<string, unknown>>;
      freeze: { rows: number; cols: number };
    }[];
  };
  results: Record<string, string>[];
};

/** The open spreadsheet as Nook has it saved, once `done` says it is (it saves a moment later). */
async function savedSheet(p: Page, done: (s: Saved) => boolean) {
  const id = new URL(p.url()).pathname.split("sheet/")[1]!.split("+")[0]!;
  const read = () =>
    p.evaluate(async (id) => {
      const r = await fetch("/api/actions/sheet.get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      });
      return ((await r.json()) as { result: Saved }).result;
    }, id);
  // Later on a busy PC: read until it has.
  let saved = await read();
  for (let waited = 0; waited < 15_000 && !done(saved); waited += 250) {
    await p.waitForTimeout(250);
    saved = await read();
  }
  if (!done(saved)) throw new Error(`saved ${JSON.stringify(saved)}`);
  return saved;
}

/**
 * A copy or a paste on a cell as the browser sends one, through a clipboard of the page's own
 * rather than the computer's. `valuesOnly` presses Ctrl+Shift+V first.
 */
const clip = (p: Page, ref: string, kind: "copy" | "paste", valuesOnly = false) =>
  p.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="Cell ${ref}"]');
    if ("${kind}" === "copy") window.__clip = new DataTransfer();
    const shiftV = { key: "V", ctrlKey: true, shiftKey: true, bubbles: true };
    if (${valuesOnly}) input.dispatchEvent(new KeyboardEvent("keydown", shiftV));
    const sent = { clipboardData: window.__clip, bubbles: true, cancelable: true };
    input.dispatchEvent(new ClipboardEvent("${kind}", sent));
  })()`);

interface Smoke {
  step: (name: string, fn: (p: Page) => Promise<void>) => Promise<void>;
  keys: (...k: string[]) => Promise<void>;
  base: string;
  tag: string;
}

export async function boardSteps({ step, keys, base, tag }: Smoke) {
  await step("a canvas board with a sticky, a box, an arrow and a task card", async (p) => {
    await p.goto(`${base}/canvases`);
    await p.getByRole("heading", { name: "Boards" }).waitFor();
    await p.getByRole("button", { name: "New board" }).click();
    // Name it and draw once the board has loaded: the toolbar shows before that, and loading sets
    // the name the board came with and frames the view, which would move what's drawn already.
    await p.getByText("Double-click anywhere to write").waitFor();
    // Named the way a person does it, clicking in and typing: the name it came with is only a hint.
    const name = p.getByLabel("Board name");
    await name.click();
    await p.keyboard.type(`Trip plan ${tag}`);
    await name.press("Enter");
    const board = p.locator("[data-toolbar]").locator("..");
    const box = (await board.boundingBox())!;
    await p.mouse.dblclick(box.x + 200, box.y + 250);
    await p.keyboard.type(`Book flights ${tag}`);
    await keys("Escape");
    // Double-clicking the card again writes more in it, not on a new card over it.
    await p.mouse.dblclick(box.x + 200, box.y + 250);
    await p.keyboard.type(" today");
    await keys("Escape");
    await p.getByTitle("Box (R)").click();
    await p.mouse.click(box.x + 600, box.y + 250);
    await p.keyboard.type("Hotel");
    await keys("Escape");
    await p.getByTitle("Arrow (A)").click();
    await p.mouse.move(box.x + 200, box.y + 250);
    await p.mouse.down();
    await p.mouse.move(box.x + 400, box.y + 250, { steps: 5 });
    await p.mouse.move(box.x + 600, box.y + 250, { steps: 5 });
    await p.mouse.up();
    await p.getByRole("button", { name: "@ Record" }).click();
    await p.getByLabel("Find a record").fill(`Pay rent ${tag}`);
    await p.getByRole("button", { name: new RegExp(`Pay rent ${tag}`) }).click();
    const id = new URL(p.url()).pathname.split("canvas/")[1]!.split("+")[0]!;
    type Saved = {
      title: string;
      board: {
        nodes: { type: string; text?: string }[];
        edges: { from: { type: string }; to: { type: string } }[];
      };
    };
    const read = () =>
      p.evaluate(async (id) => {
        const r = await fetch("/api/actions/canvas.get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        return ((await r.json()) as { result: Saved }).result;
      }, id);
    const kindsOf = (b: Saved) =>
      b.board.nodes
        .map((n) => n.type)
        .sort()
        .join(",");
    const sticky = `Book flights ${tag} today`;
    const wrote = (b: Saved) => b.board.nodes.some((n) => n.text === sticky);
    // The board saves a moment after the last change, later on a busy PC: read until it has.
    let saved = await read();
    for (let waited = 0; waited < 15_000; waited += 250) {
      if (
        saved.title === `Trip plan ${tag}` &&
        kindsOf(saved) === "entitymention,shape,text" &&
        wrote(saved) &&
        saved.board.edges.length > 0
      )
        break;
      await p.waitForTimeout(250);
      saved = await read();
    }
    const kinds = kindsOf(saved);
    if (saved.title !== `Trip plan ${tag}`) throw new Error(`board named ${saved.title}`);
    if (kinds !== "entitymention,shape,text") throw new Error(`board holds ${kinds}`);
    if (!wrote(saved)) throw new Error(`cards say ${JSON.stringify(saved.board.nodes)}`);
    const edge = saved.board.edges[0];
    if (edge?.from.type !== "connected" || edge?.to.type !== "connected")
      throw new Error(`arrow ${JSON.stringify(saved.board.edges)}`);
    await p.reload();
    await p.getByText(sticky).waitFor();
  });

  await step("a spreadsheet that adds up as you type, its total in bold as currency", async (p) => {
    await p.goto(`${base}/sheets`);
    await p.getByRole("heading", { name: "Sheets" }).waitFor();
    await p.getByRole("button", { name: "New spreadsheet" }).click();
    await p.locator('[data-cell="A1"]').waitFor();
    const name = p.getByLabel("Spreadsheet name");
    await name.click();
    await p.keyboard.type(`Budget ${tag}`);
    await name.press("Enter");
    await p.locator('[data-cell="A1"]').click();
    for (const v of ["1200", "300", "=SUM(A1:A2)"]) {
      await p.keyboard.type(v);
      await keys("Enter");
    }
    const total = p.locator('[data-cell="A3"]');
    await total.filter({ hasText: "1500" }).waitFor();
    // The way a person formats it: click the total, Ctrl+B, Currency, and keep the top row put.
    await total.click();
    await keys("Control+b");
    await p.getByRole("button", { name: "Number format" }).click();
    await p.getByRole("menuitem", { name: /^Currency/ }).click();
    await p.getByRole("button", { name: "Freeze top row" }).click();
    await total.filter({ hasText: "$1,500.00" }).waitFor();
    await savedSheet(
      p,
      (s) =>
        s.title === `Budget ${tag}` &&
        s.book.sheets[0]?.cells.A3 === "=SUM(A1:A2)" &&
        s.results[0]?.A3 === "$1,500.00" &&
        s.book.sheets[0]?.formats.A3?.bold === true &&
        s.book.sheets[0]?.formats.A3?.number === "currency" &&
        s.book.sheets[0]?.freeze.rows === 1,
    );
    await p.reload();
    await total.filter({ hasText: "$1,500.00" }).waitFor();
    const weight = await total.evaluate(
      (el) => el.ownerDocument.defaultView.getComputedStyle(el).fontWeight as string,
    );
    if (Number(weight) < 600) throw new Error(`the total's weight is ${weight}, not bold`);
    // Scrolled down, the top row is still there under the column letters.
    const grid = p.locator("[data-sheet-grid]");
    const scrolled = await grid.evaluate((el) => {
      el.scrollTo({ top: el.scrollHeight });
      return el.scrollTop as number;
    });
    const [box, a1] = await Promise.all([
      grid.boundingBox(),
      p.locator('[data-cell="A1"]').boundingBox(),
    ]);
    const below = (a1?.y ?? 0) - (box?.y ?? 0);
    if (scrolled < 100 || Math.abs(below - 24) > 2)
      throw new Error(`row 1 after scrolling ${scrolled} px is ${below} px down`);
  });

  await step("a sheet's first column stays put, and a copy pastes with its formats", async (p) => {
    // The total copied and pasted two rows down brings its formula, bold and currency; pasted
    // beside that with Ctrl+Shift+V, it's just the total's value, 1500.
    const grid = p.locator("[data-sheet-grid]");
    await grid.evaluate((el) => el.scrollTo({ top: 0, left: 0 }));
    await p.locator('[data-cell="A3"]').click();
    await clip(p, "A3", "copy");
    await p.locator('[data-cell="A5"]').click();
    await clip(p, "A5", "paste");
    await p.locator('[data-cell="B5"]').click();
    await clip(p, "B5", "paste", true);
    await p.getByRole("button", { name: "Freeze first column" }).click();
    await p.locator('[data-cell="A5"]').filter({ hasText: "$1,500.00" }).waitFor();
    await savedSheet(p, (s) => {
      const sheet = s.book.sheets[0];
      return (
        sheet?.cells.A5 === "=SUM(A1:A2)" &&
        sheet.formats.A5?.bold === true &&
        sheet.formats.A5?.number === "currency" &&
        sheet.cells.B5 === "1500" &&
        sheet.formats.B5 === undefined &&
        sheet.freeze.rows === 1 &&
        sheet.freeze.cols === 1
      );
    });
    // Narrowed, so the sheet scrolls sideways: column A stays beside the row numbers, and A1, where
    // the row and the column that stay put meet, stays over everything scrolling under it.
    await p.setViewportSize({ width: 800, height: 900 });
    const across = await grid.evaluate((el) => {
      el.scrollTo({ left: el.scrollWidth, top: el.scrollHeight });
      return el.scrollLeft as number;
    });
    const [box, a1] = await Promise.all([
      grid.boundingBox(),
      p.locator('[data-cell="A1"]').boundingBox(),
    ]);
    const left = (a1?.x ?? 0) - (box?.x ?? 0);
    const onTop = await p.evaluate(`(() => {
      const a1 = document.querySelector('[data-cell="A1"]').getBoundingClientRect();
      const hit = document.elementFromPoint(a1.x + a1.width / 2, a1.y + a1.height / 2);
      return hit?.closest("[data-cell]")?.dataset.cell ?? null;
    })()`);
    if (across < 100 || Math.abs(left - 40) > 2 || onTop !== "A1")
      throw new Error(
        `column A after scrolling ${across} px across is ${left} px in, under ${onTop}`,
      );
    // Arrowing back to the column beside A (B5, by way of C5) brings it out from under A.
    await keys("ArrowRight", "ArrowLeft");
    const b5Shows = `(() => {
      const b5 = document.querySelector('[data-cell="B5"]').getBoundingClientRect();
      const hit = document.elementFromPoint(b5.x + 4, b5.y + b5.height / 2);
      return hit?.closest("[data-cell]")?.dataset.cell === "B5";
    })()`;
    await p.waitForFunction(b5Shows, undefined, { timeout: 5000 }).catch(async () => {
      const b5 = await p.locator('[data-cell="B5"]').boundingBox();
      throw new Error(`B5 is under column A: ${(b5?.x ?? 0) - (box?.x ?? 0)} px in`);
    });
    await p.setViewportSize({ width: 1440, height: 900 });
  });
}
