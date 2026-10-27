// Moving events on Calendar by hand, as you'd see it: your own event saves as it's dropped; a
// meeting with guests saves nothing till you say Move, since its guests get an update, and Cancel
// puts it back; a drop where it was saves nothing. A saved move stays put till Calendar has read it
// back, and one that read still has at the old time goes back and says so.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalEvent } from "./types.ts";

// Solid's browser build: the server build tests run with by default isn't reactive.
// @ts-expect-error: the browser build has no types of its own; they're the package's.
vi.mock("solid-js", () => import("solid-js/dist/solid.js"));

const act = vi.fn();
const show = vi.fn();
vi.mock("./query.ts", () => ({ act: (...a: unknown[]) => act(...a) }));
vi.mock("./live.ts", () => ({ toast: { show: (...a: unknown[]) => show(...a) } }));

const TEN = "2026-10-27T10:00:00.000Z";
const ELEVEN = "2026-10-27T11:00:00.000Z";
const NOON = "2026-10-27T12:00:00.000Z";
const ONE = "2026-10-27T13:00:00.000Z";
const at = {} as DOMRect;
const later = { start: new Date(NOON), end: new Date(ONE) };

const event = (more: Partial<CalEvent> = {}) =>
  ({
    id: "e1",
    title: "Dentist",
    startsAt: TEN,
    endsAt: ELEVEN,
    allDay: false,
    status: "confirmed",
    selfOrganizer: true,
    canWrite: true,
    attendees: [],
    ...more,
  }) as CalEvent;
const meeting = () =>
  event({
    title: "Planning",
    attendees: [{ email: "me@x.com", self: true }, { email: "sam@x.com" }],
  });

/** Saved where it was asked to go, as Nook answers. */
const saves = () =>
  act.mockImplementation(async (_name: string, i: { id: string; start: string; end: string }) =>
    event({ id: i.id, startsAt: i.start, endsAt: i.end }),
  );
const settle = () => new Promise((r) => setTimeout(r, 0));

async function setup(first: CalEvent) {
  const { createRoot, createSignal } = await import("solid-js");
  const { createMoves } = await import("./calMoves.ts");
  return createRoot((dispose) => {
    const [list, setList] = createSignal<readonly CalEvent[]>([first]);
    const [readAt, setReadAt] = createSignal(0);
    const moves = createMoves(list, readAt);
    const drawn = () => moves.shown().find((e) => e.id === first.id)!;
    /** Calendar reads its events again, as they are at Nook. */
    const read = (e: CalEvent) => {
      setList([e]);
      setReadAt(Date.now() + 1);
    };
    return { moves, drawn, read, dispose };
  });
}

beforeEach(() => {
  act.mockReset();
  show.mockReset();
});

describe("dropping your own event", () => {
  it("saves it through update_event as it's dropped, and draws it there", async () => {
    saves();
    const { moves, drawn, dispose } = await setup(event());
    moves.drop(drawn(), later, at);
    expect(drawn().startsAt).toBe(NOON);
    expect(act).toHaveBeenCalledWith("calendar.update_event", { id: "e1", start: NOON, end: ONE });
    expect(moves.can(drawn())).toBe(false);
    await settle();
    expect(drawn().startsAt).toBe(NOON);
    expect(moves.can(drawn())).toBe(true);
    dispose();
  });

  it("saves nothing when it's dropped where it was", async () => {
    const { moves, drawn, dispose } = await setup(event());
    moves.drop(drawn(), { start: new Date(TEN), end: new Date(ELEVEN) }, at);
    expect(act).not.toHaveBeenCalled();
    expect(drawn().startsAt).toBe(TEN);
    dispose();
  });

  it("goes back where it was when the save fails", async () => {
    act.mockResolvedValue(null);
    const { moves, drawn, dispose } = await setup(event());
    moves.drop(drawn(), later, at);
    expect(drawn().startsAt).toBe(NOON);
    await settle();
    expect(drawn().startsAt).toBe(TEN);
    dispose();
  });
});

describe("dropping a meeting with guests", () => {
  it("asks first, and saves nothing till you say Move", async () => {
    saves();
    const { moves, drawn, dispose } = await setup(meeting());
    moves.drop(drawn(), later, at);
    expect(moves.asking()).toMatchObject({ guests: 1, to: later });
    // It waits where it was dropped while you decide.
    expect(drawn().startsAt).toBe(NOON);
    await settle();
    expect(act).not.toHaveBeenCalled();
    moves.answer(true);
    expect(moves.asking()).toBeUndefined();
    expect(act).toHaveBeenCalledWith("calendar.update_meeting", {
      id: "e1",
      start: NOON,
      end: ONE,
    });
    await settle();
    expect(show).toHaveBeenCalledWith("Moved. Its guest gets an update.", "ok");
    dispose();
  });

  it("puts it back on Cancel, telling nobody", async () => {
    const { moves, drawn, dispose } = await setup(meeting());
    moves.drop(drawn(), later, at);
    moves.answer(false);
    await settle();
    expect(act).not.toHaveBeenCalled();
    expect(moves.asking()).toBeUndefined();
    expect(drawn().startsAt).toBe(TEN);
    dispose();
  });

  it("goes back to an earlier move not read back yet, not to the old time", async () => {
    saves();
    const { moves, drawn, dispose } = await setup(meeting());
    moves.drop(drawn(), later, at);
    moves.answer(true);
    await settle();
    expect(drawn().startsAt).toBe(NOON);
    moves.drop(drawn(), { start: new Date(ONE), end: new Date("2026-10-27T14:00:00.000Z") }, at);
    expect(drawn().startsAt).toBe(ONE);
    moves.answer(false);
    expect(drawn().startsAt).toBe(NOON);
    expect(act).toHaveBeenCalledTimes(1);
    dispose();
  });
});

describe("after a save", () => {
  it("stays where it was saved till a read after the save, however long that takes", async () => {
    vi.useFakeTimers();
    saves();
    const { moves, drawn, read, dispose } = await setup(event());
    moves.drop(drawn(), later, at);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(drawn().startsAt).toBe(NOON);
    read(event({ startsAt: NOON, endsAt: ONE }));
    expect(drawn().startsAt).toBe(NOON);
    expect(show).not.toHaveBeenCalled();
    vi.useRealTimers();
    dispose();
  });

  it("goes back, and says so, when the read after the save still has the old time", async () => {
    saves();
    const { moves, drawn, read, dispose } = await setup(event());
    moves.drop(drawn(), later, at);
    await settle();
    read(event());
    expect(drawn().startsAt).toBe(TEN);
    expect(show).toHaveBeenCalledWith(
      "“Dentist” didn't move: Nook still has it at its old time.",
      "error",
    );
    dispose();
  });
});
