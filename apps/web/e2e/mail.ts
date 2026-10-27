// Mail's bundles (PR #184), end to end on the seeded inbox (apps/server/src/testing/seed-world.ts),
// sorted by Nook's own rules as sync brought it in: People on top with the person's conversation,
// Updates, Receipts and Newsletters one row each with how many; a receipt moved to People with its
// menu shows there, and Undo puts it back.

import type { Page } from "playwright";
import { BUNDLE_COUNTS, INBOX } from "../../server/src/testing/seed-world.ts";
import type { Seeded } from "../../server/src/testing/seeded.ts";

type Step = (name: string, fn: () => Promise<void>) => Promise<void>;

/** Runs an action as the app would, from the page (same origin, development login). */
async function run<T>(p: Page, name: string, input: unknown): Promise<T> {
  const r = (await p.evaluate(
    async ([n, i]) => {
      const res = await fetch(`/api/actions/${n}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(i),
      });
      return res.json();
    },
    [name, input] as const,
  )) as { status: string; result: T };
  if (r.status !== "ok") throw new Error(`${name} answered ${JSON.stringify(r)}`);
  return r.result;
}

type Listed = { subject: string; bundle: string; bundleMoved: boolean };

export async function mailSteps(p: Page, seeded: Seeded, step: Step) {
  const bundles = p.getByRole("list", { name: "Bundles" });
  /** A bundle's row under People, by its name. */
  const row = (name: string) => bundles.getByRole("button", { name: new RegExp(`^${name}\\b`) });
  /** A conversation's row in the list shown, by its subject. */
  const thread = (subject: string) => p.locator("li", { hasText: subject });
  const receipt = INBOX.receipt.subject;
  /** Where the receipt is, as Nook has it. */
  const placed = async () => {
    const all = await run<Listed[]>(p, "mail.threads", { view: "inbox" });
    return all.find((t) => t.subject === receipt);
  };

  await step(
    "Mail puts the person's conversation in People, and folds each other bundle into a row with its count",
    async () => {
      await p.goto(`${seeded.base}/mail`);
      await thread(INBOX.person.subject).waitFor();
      await row("Updates").waitFor();
      const shown = (await bundles.getByRole("button").allInnerTexts()).map((t) =>
        t.replace(/\s+/g, " ").trim(),
      );
      const want = [
        ["Updates", BUNDLE_COUNTS.updates],
        ["Receipts", BUNDLE_COUNTS.receipts],
        ["Newsletters", BUNDLE_COUNTS.newsletters],
      ] as const;
      if (
        shown.length !== want.length ||
        want.some(([n, c], i) => !shown[i]?.startsWith(`${n} ${c} `))
      )
        throw new Error(`the bundle rows read ${JSON.stringify(shown)}`);
      // Only People's conversations are listed on their own.
      for (const other of [
        receipt,
        INBOX.shipping.subject,
        INBOX.notice.subject,
        INBOX.newsletter.subject,
      ])
        if (await thread(other).count()) throw new Error(`"${other}" is listed with People`);
    },
  );

  await step(
    "a receipt moved to People with its menu shows there, and Undo puts it back",
    async () => {
      await row("Receipts").click();
      await p.getByRole("heading", { name: "Receipts", level: 2 }).waitFor();
      const item = thread(receipt);
      await item.hover();
      await item.getByRole("button", { name: `Move ${receipt} to another bundle` }).click();
      await p.getByRole("menuitem", { name: "Move to People" }).click();
      await p.getByText("Moved to People.").waitFor();
      await item.waitFor({ state: "detached" });
      await p.getByTitle(/^Back to the inbox/).click();
      await thread(receipt).waitFor();
      // Receipts held only that one: its row goes.
      await row("Receipts").waitFor({ state: "detached" });
      const moved = await placed();
      if (moved?.bundle !== "people" || !moved.bundleMoved)
        throw new Error(`after the move Nook has ${JSON.stringify(moved)}`);

      await p.getByRole("button", { name: "Undo" }).click();
      await thread(receipt).waitFor({ state: "detached" });
      await row("Receipts").waitFor();
      const back = await placed();
      if (back?.bundle !== "receipts" || back.bundleMoved)
        throw new Error(`after Undo Nook has ${JSON.stringify(back)}`);
    },
  );
}
