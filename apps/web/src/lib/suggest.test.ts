// Pip's suggested times: what's asked for the days shown, each free time cut to the length asked
// at its start, a few a day and ten in all, never begun, past the days shown or across midnight;
// who's a guest (an address the server takes, and not yours); and how Calendar says who's invited,
// whose calendar it couldn't see, who a time suits, and how far ahead it knows yours.
import { describe, expect, it } from "vitest";
import {
  addressKey,
  everyone,
  findInput,
  foundLine,
  guestList,
  guestName,
  inviteQuestion,
  knownFor,
  knownLine,
  readGuests,
  suggest,
  suggestedOn,
  suggestionLabel,
  titleFor,
  unseenLines,
} from "./suggest.ts";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const slot = (a: Date, b: Date) => ({ start: a.toISOString(), end: b.toISOString() });
/** The week of Sun Oct 25 to Sat Oct 31, 2026. */
const week = { from: new Date(2026, 9, 25), to: new Date(2026, 10, 1) };
const now = at(27, 8);

describe("findInput", () => {
  it("asks free_time for just you, over the days shown", () => {
    expect(findInput(week, 30, [], now)).toEqual({
      action: "calendar.free_time",
      input: { minutes: 30, from: week.from.toISOString(), days: 7 },
    });
  });

  it("asks find_time with the guests", () => {
    const ask = findInput(week, 45, ["sam@work.example"], now);
    expect(ask?.action).toBe("calendar.find_time");
    expect(ask?.input).toMatchObject({ minutes: 45, days: 7, guests: ["sam@work.example"] });
  });

  it("asks at most 30 days, at least one", () => {
    const month = { from: new Date(2026, 9, 1), to: new Date(2026, 10, 2) };
    expect(findInput(month, 30, [], at(1, 8))?.input.days).toBe(30);
    expect(findInput({ from: at(27, 0), to: at(27, 0) }, 30, [], at(26, 8))?.input.days).toBe(1);
  });

  it("asks nothing for days that have passed", () => {
    expect(findInput(week, 30, [], new Date(2026, 10, 1))).toBeNull();
  });
});

describe("suggest", () => {
  it("starts each at its free time's start, as long as asked", () => {
    const got = suggest([slot(at(27, 9), at(27, 12)), slot(at(28, 14), at(28, 15))], 45, week);
    expect(got).toEqual([
      { start: at(27, 9), end: at(27, 9, 45) },
      { start: at(28, 14), end: at(28, 14, 45) },
    ]);
  });

  it("leaves out a free time shorter than asked", () => {
    expect(suggest([slot(at(27, 9), at(27, 9, 30))], 60, week)).toEqual([]);
  });

  it("keeps to the days shown, and never runs past midnight", () => {
    const got = suggest(
      [
        slot(at(24, 9), at(24, 10)),
        slot(at(27, 23, 30), at(28, 1)),
        slot(at(31, 23, 30), at(32, 1)),
        slot(at(32, 9), at(32, 10)),
      ],
      60,
      week,
    );
    expect(got).toEqual([]);
  });

  it("takes three a day and ten in all, earliest first", () => {
    const slots = [];
    for (let d = 26; d <= 30; d++)
      for (const h of [16, 9, 11, 14]) slots.push(slot(at(d, h), at(d, h + 1)));
    const got = suggest(slots, 30, week);
    expect(got).toHaveLength(10);
    expect(suggestedOn(got, new Date(2026, 9, 26)).map((s) => s.start.getHours())).toEqual([
      9, 11, 14,
    ]);
    expect(got.at(-1)?.start).toEqual(at(29, 9));
    const some = suggest(slots, 30, week, { perDay: 1, most: 3 });
    expect(some.map((s) => s.start.getDate())).toEqual([26, 27, 28]);
  });

  it("drops a time that has begun", () => {
    const slots = [slot(at(27, 9), at(27, 12)), slot(at(27, 14), at(27, 15))];
    expect(suggest(slots, 30, week, { now: at(27, 9) }).map((s) => s.start)).toEqual([at(27, 14)]);
    expect(suggest(slots, 30, week, { now: at(27, 8, 59) })).toHaveLength(2);
  });
});

describe("knownFor", () => {
  it("says where the days shown run past the 60 Nook keeps", () => {
    const today = new Date(2026, 9, 27);
    expect(knownFor(week, today)).toBeUndefined();
    const late = { from: new Date(2026, 11, 20), to: new Date(2026, 11, 27) };
    expect(knownFor(late, today)).toBe(new Date(2026, 11, 26).toISOString());
  });
});

describe("readGuests", () => {
  it("reads addresses split any way, each once", () => {
    expect(readGuests("sam@work.example, lee@work.example;SAM@work.example  jo@x.io")).toEqual({
      guests: ["sam@work.example", "lee@work.example", "jo@x.io"],
      bad: [],
    });
  });

  it("takes the address from a name and address, and says what isn't one", () => {
    expect(readGuests("Lee Park <lee@work.example>, sam")).toEqual({
      guests: ["lee@work.example"],
      bad: ["sam"],
    });
    expect(readGuests("  ")).toEqual({ guests: [], bad: [] });
  });

  it("refuses what the server's email check would", () => {
    expect(readGuests("a@b.c, .x@y.io, x..y@y.io, ok_1+tag@sub.y.io").bad).toEqual([
      "a@b.c",
      ".x@y.io",
      "x..y@y.io",
    ]);
  });

  it("leaves out your own addresses, however they're written", () => {
    const own = ["me.here@gmail.com", "boss@work.example"];
    expect(readGuests("MeHere+cal@gmail.com, Boss@Work.example", own)).toEqual({
      guests: [],
      bad: [],
    });
    expect(readGuests("boss@work.example, sam@work.example", own).guests).toEqual([
      "sam@work.example",
    ]);
    expect(addressKey(" Me.Here+x@googlemail.com ")).toBe("mehere@gmail.com");
  });
});

describe("how guests are named", () => {
  it("names a guest by their address's words, else the address", () => {
    expect(guestName("lee@work.example")).toBe("Lee");
    expect(guestName("sam.lee@work.example")).toBe("Sam Lee");
    expect(guestName("j2k@work.example")).toBe("j2k@work.example");
  });

  it("names every guest up to four, then the first three and how many more", () => {
    expect(guestList(["sam@a.io"])).toBe("Sam");
    expect(guestList(["sam@a.io", "lee@a.io"])).toBe("Sam and Lee");
    expect(guestList(["sam@a.io", "lee@a.io", "jo@a.io", "pat@a.io"])).toBe("Sam, Lee, Jo and Pat");
    const six = ["sam", "lee", "jo", "pat", "kim", "ali"].map((n) => `${n}@a.io`);
    expect(guestList(six)).toBe("Sam, Lee, Jo and 3 others");
    expect(everyone(six)).toBe("Sam, Lee, Jo, Pat, Kim and Ali");
  });

  it("calls an untitled one a meeting with them, or Busy for you alone", () => {
    expect(titleFor(" Sync ", ["sam@a.io"])).toBe("Sync");
    expect(titleFor("", ["sam@a.io", "lee@a.io"])).toBe("Meeting with Sam and Lee");
    expect(titleFor("  ", [])).toBe("Busy");
  });
});

describe("what Calendar says", () => {
  const s = { start: at(29, 10, 30), end: at(29, 11) };
  const three = ["sam@a.io", "lee@a.io", "jo@a.io"];

  it("asks before inviting, naming them, the meeting and when", () => {
    expect(inviteQuestion("Sync", three, s, now)).toBe(
      "Invite Sam, Lee and Jo to “Sync” Thu, Oct 29, 10:30 to 11 a.m.?",
    );
    expect(inviteQuestion("x".repeat(80), ["sam@a.io"], s, now)).toMatch(/^Invite Sam to “x{59}…”/);
  });

  it("names a suggestion for a screen reader by when and what it does", () => {
    expect(suggestionLabel(s, [], now)).toBe(
      "Pip suggests Thu, Oct 29, 10:30 to 11 a.m.: add it to your calendar",
    );
    expect(suggestionLabel(s, ["sam@a.io"], now)).toBe(
      "Pip suggests Thu, Oct 29, 10:30 to 11 a.m.: invite Sam",
    );
  });

  it("says whose calendar it couldn't see, and why, but not those it never asked", () => {
    expect(
      unseenLines([
        {
          address: "lee@a.io",
          why: "Their calendar isn't shared with any of your Google accounts.",
        },
        { address: "jo@a.io", why: "Google couldn't be asked." },
        { address: "sam@a.io", why: "Not asked: those times have passed." },
      ]),
    ).toEqual([
      "Couldn't see Lee's calendar: it isn't shared with your Google accounts.",
      "Couldn't see Jo's calendar: Google couldn't be asked.",
    ]);
  });

  it("says the last day Nook knows", () => {
    expect(knownLine(new Date(2026, 11, 25).toISOString(), now)).toBe(
      "Nook knows your calendar only through Thu, Dec 24.",
    );
  });

  it("says how many it suggests and what picking one does, or that none fit", () => {
    expect(foundLine(3, 30, [], [], "that week")).toBe(
      "Pip suggests 3 times that week. Pick one to add it.",
    );
    expect(foundLine(1, 60, ["Sam@a.io"], ["sam@a.io"], "that day")).toBe(
      "Pip suggests 1 time that day when you're all free. Pick one to invite Sam.",
    );
    expect(foundLine(0, 60, [], [], "that week")).toBe("Nothing free that week for 1 hour.");
    expect(foundLine(0, 45, three, three, "in October")).toBe(
      "No time in October when you're all free for 45 min.",
    );
  });

  it("says a time suits only the guests whose calendars it saw", () => {
    expect(foundLine(2, 30, three, ["sam@a.io"], "that week")).toBe(
      "Pip suggests 2 times that week when you and Sam are free. Pick one to invite Sam, Lee and Jo.",
    );
    expect(foundLine(2, 30, ["lee@a.io"], [], "that week")).toBe(
      "Pip suggests 2 times that week when you're free. Pip couldn't see anyone else's calendar. Pick one to invite Lee.",
    );
    expect(foundLine(0, 30, three, [], "that day")).toBe(
      "Nothing free that day for 30 min. Pip couldn't see anyone else's calendar.",
    );
  });
});
