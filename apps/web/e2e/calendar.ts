// Calendar's drag (PR #185), end to end on the seeded day (apps/server/src/testing/seed-world.ts):
// your own event saves where it's dropped, a meeting with guests asks first and Cancel puts it
// back, Move saves it and has Google tell the guests, and someone else's meeting doesn't move.
// What Google was sent is read from the seeded server's fake.

import { atLocal } from "@hearth/core";
import type { Locator, Page } from "playwright";
import { ME, SEED_TZ, WEEK } from "../../server/src/testing/seed-world.ts";
import type { Seeded } from "../../server/src/testing/seeded.ts";

type Step = (name: string, fn: () => Promise<void>) => Promise<void>;

/** TimeGrid's height of an hour, in px. */
const HOUR = 48;

async function until(what: string, fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out: ${what}`);
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** An event on the grid: its label is its title, then when it is ("…, 10 to 11 a.m."). */
const tile = (p: Page, title: string, when = "") =>
  p.getByRole("button", { name: new RegExp(`^${literal(title)}, .*${literal(when)}`) });

/** Presses an event and drags it `dy` px down, as a mouse does, then lets go. */
async function drag(p: Page, el: Locator, dy: number) {
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) throw new Error("the event isn't on screen");
  // Its middle: the bottom edge stretches it instead.
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  await p.mouse.move(x, y + dy, { steps: 12 });
  await p.mouse.up();
}

export async function calendarSteps(p: Page, seeded: Seeded, step: Step) {
  const { today } = seeded;
  const at = (minute: number) => atLocal(today, minute, SEED_TZ).getTime();
  /** Where an event is at Google now. */
  const atGoogle = (id: string) => {
    const start = seeded.google.calendars.get(ME)?.events.get(id)?.start?.dateTime;
    return start ? new Date(start).getTime() : null;
  };
  /** The changes Nook sent Google for an event. */
  const changes = (id: string) =>
    seeded.sent.filter((s) => s.method === "PATCH" && s.url.pathname.endsWith(`/events/${id}`));
  const { own, meeting, theirs, allDay, repeating } = WEEK;

  await step(
    "Calendar shows the seeded week: all day, repeating, and others' meetings",
    async () => {
      await p.goto(`${seeded.base}/calendar`);
      await tile(p, own.title, "10 to 11 a.m.").waitFor();
      await tile(p, meeting.title, "2 to 3 p.m.").waitFor();
      await tile(p, theirs.title, "5 to 6 p.m.").waitFor();
      await tile(p, allDay.title, "all day").waitFor();
      // One time a day, every day of the week.
      const standups = await tile(p, repeating.title).count();
      if (standups !== 7) throw new Error(`${standups} standups in the week, not 7`);
    },
  );

  await step(
    "your own event saves where it's dropped, quietly, and a reload has it there",
    async () => {
      await drag(p, tile(p, own.title), 2 * HOUR);
      await until("Google has the Dentist at noon", () => atGoogle(own.id) === at(12 * 60));
      const sent = changes(own.id);
      if (sent.length !== 1 || sent[0]!.url.searchParams.get("sendUpdates") !== "none")
        throw new Error(`the Dentist went to Google as ${sent.map((s) => s.url.search)}`);
      await p.reload();
      await tile(p, own.title, "12 to 1 p.m.").waitFor();
    },
  );

  // Where it goes: an hour later, the same day.
  const day = new Date(at(meeting.from)).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: SEED_TZ,
  });
  const question = `Move “${meeting.title}” to ${day}, 3 p.m. and tell 2 guests?`;
  const ask = p.getByRole("alertdialog");

  await step(
    "a meeting with guests asks first, naming it, its time and its guests; Cancel puts it back",
    async () => {
      // Measured once it's in view: the drag doesn't scroll the grid after that.
      await tile(p, meeting.title).scrollIntoViewIfNeeded();
      const before = await tile(p, meeting.title).boundingBox();
      await drag(p, tile(p, meeting.title), HOUR);
      await ask.waitFor();
      const said = await ask.locator("p").innerText();
      if (said !== question) throw new Error(`the meeting asked "${said}", not "${question}"`);
      await ask.getByRole("button", { name: "Cancel" }).click();
      await ask.waitFor({ state: "detached" });
      await tile(p, meeting.title, "2 to 3 p.m.").waitFor();
      const after = await tile(p, meeting.title).boundingBox();
      if (Math.abs((after?.y ?? 0) - (before?.y ?? 0)) > 1)
        throw new Error(
          `the meeting is ${(after?.y ?? 0) - (before?.y ?? 0)} px from where it was`,
        );
      await p.waitForTimeout(500);
      if (changes(meeting.id).length) throw new Error("Cancel still changed the meeting at Google");
      if (atGoogle(meeting.id) !== at(meeting.from)) throw new Error("the meeting moved at Google");
    },
  );

  await step("Move saves the meeting, and Google is asked to tell its guests", async () => {
    await drag(p, tile(p, meeting.title), HOUR);
    await ask.waitFor();
    await ask.getByRole("button", { name: "Move" }).click();
    await p.getByText("Moved. Its guests get an update.").waitFor();
    await until("Google has the meeting at 3", () => atGoogle(meeting.id) === at(15 * 60));
    const sent = changes(meeting.id);
    if (sent.length !== 1 || sent[0]!.url.searchParams.get("sendUpdates") !== "all")
      throw new Error(`the meeting went to Google as ${sent.map((s) => s.url.search)}`);
    await p.reload();
    await tile(p, meeting.title, "3 to 4 p.m.").waitFor();
  });

  await step("someone else's meeting can't be picked up", async () => {
    const theirsNow = tile(p, theirs.title);
    const grabs = async (title: string) =>
      (await tile(p, title).getAttribute("class"))?.includes("cursor-grab");
    if (!(await grabs(own.title))) throw new Error("your own event doesn't show the grab cursor");
    if (await grabs(theirs.title)) throw new Error("Priya's meeting shows the grab cursor");
    await drag(p, theirsNow, HOUR);
    await p.waitForTimeout(500);
    if (await ask.count()) throw new Error("dragging Priya's meeting asked to move it");
    // A press that didn't pick it up may have opened it instead.
    const popover = p.getByRole("dialog", { name: theirs.title });
    if (await popover.count()) {
      await popover.press("Escape");
      await popover.waitFor({ state: "detached" });
    }
    await tile(p, theirs.title, "5 to 6 p.m.").waitFor();
    if (changes(theirs.id).length || atGoogle(theirs.id) !== at(theirs.from))
      throw new Error("Priya's meeting changed at Google");
  });
}
