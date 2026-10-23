import { describe, expect, it } from "vitest";
import { firedWords, type TriggerKindView, waitsFor } from "./triggers.ts";

const kinds: TriggerKindView[] = [
  { kind: "mail.received", label: "An email arrives", fields: [{ key: "from", label: "From" }] },
  {
    kind: "task.assigned",
    label: "A task is assigned",
    fields: [
      {
        key: "to",
        label: "To",
        values: [
          { value: "owner", label: "You" },
          { value: "jarvis", label: "Pip" },
        ],
      },
    ],
  },
];

describe("a trigger in words", () => {
  it("says what it waits for, with its filter's values as Settings offers them", () => {
    const mail = { on: "mail.received", onLabel: "An email arrives" };
    expect(waitsFor({ ...mail, filter: {} }, kinds)).toBe("an email arrives");
    expect(waitsFor({ ...mail, filter: { from: "Ana@Acme.com" } }, kinds)).toBe(
      "an email arrives · From: Ana@Acme.com",
    );
    expect(
      waitsFor(
        { on: "task.assigned", onLabel: "A task is assigned", filter: { to: "jarvis" } },
        kinds,
      ),
    ).toBe("a task is assigned · To: Pip");
  });

  it("says how its day is going, and when it's used its turns", () => {
    expect(firedWords({ firedToday: 0, perDay: 10, lastFiredAt: null })).toBe(
      "0 of 10 turns today, never fired yet",
    );
    expect(firedWords({ firedToday: 3, perDay: 3, lastFiredAt: "2026-10-01T14:00:00Z" })).toBe(
      "Started its 3 turns today; resting until tomorrow",
    );
  });
});
