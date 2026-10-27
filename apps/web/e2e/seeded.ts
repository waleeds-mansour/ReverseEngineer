// End-to-end check of what needs a calendar and a mailbox to work with: dragging events on
// Calendar (calendar.ts) and Mail's bundles (mail.ts). It starts its own seeded server in this
// process (apps/server/src/testing/seeded.ts): development login, a fake Google holding today's
// events and a small inbox that Nook's own sync brings in, and a database of its own on the test
// cluster, dropped at the end. It refuses to start without HEARTH_DEV_AUTH=1.
//
//   pnpm build:web
//   HEARTH_DEV_AUTH=1 HEARTH_TEST_DATABASE_URL=postgres://hearth@localhost:5499/postgres \
//     HEARTH_E2E_PORT=4486 node apps/web/e2e/seeded.ts
//
// HEARTH_WEB_DIST is the built web app to serve (apps/web/dist by default). HEARTH_E2E_CHROME
// points at a Chromium to use instead of Playwright's own download.

import { join } from "node:path";
import { chromium } from "playwright";
import { SEED_TZ } from "../../server/src/testing/seed-world.ts";
import { startSeeded } from "../../server/src/testing/seeded.ts";
import { calendarSteps } from "./calendar.ts";
import { home } from "./home.ts";
import { mailSteps } from "./mail.ts";

const port = Number(process.env.HEARTH_E2E_PORT ?? 4486);
const webDist = process.env.HEARTH_WEB_DIST ?? join(import.meta.dirname, "../dist");

const seeded = await startSeeded({ port, webDist });
const problems: string[] = [];
try {
  const browser = await chromium.launch(
    process.env.HEARTH_E2E_CHROME ? { executablePath: process.env.HEARTH_E2E_CHROME } : {},
  );
  try {
    // The seeded day is laid out where Nook's days are by default, so the browser is there too.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      timezoneId: SEED_TZ,
      locale: "en-US",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
    const step = async (name: string, fn: () => Promise<void>) => {
      const started = Date.now();
      await fn();
      console.log(`✓ ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    };
    await page.goto(seeded.base);
    await home(page).waitFor();
    await calendarSteps(page, seeded, step);
    await mailSteps(page, seeded, step);
  } finally {
    await browser.close();
  }
} finally {
  await seeded.stop();
}

if (problems.length) {
  console.error(`Problems:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("All good.");
