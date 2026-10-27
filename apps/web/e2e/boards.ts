// Smoke steps for the canvas and spreadsheets (M7), run from smoke.ts.
import type { Page } from "playwright";

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
    const id = new URL(p.url()).pathname.split("sheet/")[1]!.split("+")[0]!;
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
    const read = () =>
      p.evaluate(async (id) => {
        const r = await fetch("/api/actions/sheet.get", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        });
        return ((await r.json()) as { result: Saved }).result;
      }, id);
    const done = (s: Saved) =>
      s.title === `Budget ${tag}` &&
      s.book.sheets[0]?.cells.A3 === "=SUM(A1:A2)" &&
      s.results[0]?.A3 === "$1,500.00" &&
      s.book.sheets[0]?.formats.A3?.bold === true &&
      s.book.sheets[0]?.formats.A3?.number === "currency" &&
      s.book.sheets[0]?.freeze.rows === 1;
    // The sheet saves a moment after the last change, later on a busy PC: read until it has.
    let saved = await read();
    for (let waited = 0; waited < 15_000 && !done(saved); waited += 250) {
      await p.waitForTimeout(250);
      saved = await read();
    }
    if (!done(saved)) throw new Error(`saved ${JSON.stringify(saved)}`);
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
}
