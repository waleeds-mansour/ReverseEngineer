// Find a time's state on Calendar: what you typed, what was asked, the times Pip suggests in the
// days shown, and what picking one does. Just you, it's added straight away (it's your own
// calendar, with Undo); with guests it asks once, beside the time, before they're invited, and
// your Invite is the yes, sending exactly who and what the question named. Changing Who or how
// long drops what was found, so a time is never picked for guests you've since taken out; a time
// that has begun is dropped too, and refused if it's picked. Going to other days asks about those.

import { type Accessor, batch, createMemo, createSignal, onCleanup } from "solid-js";
import { daysOn } from "../../lib/calLayout.ts";
import { timeNow } from "../../lib/clock.ts";
import type { CalendarSetup } from "../../lib/integration-types.ts";
import { toast } from "../../lib/live.ts";
import { act, useAction } from "../../lib/query.ts";
import {
  DEFAULT_LENGTH,
  everyone,
  type FoundTimes,
  type FreeSlot,
  findInput,
  guestList,
  inviteQuestion,
  knownFor,
  type Range,
  readGuests,
  type Suggestion,
  suggest,
  titleFor,
} from "../../lib/suggest.ts";
import type { CalEvent } from "../../lib/types.ts";
import { when } from "./parts.tsx";

/** What was asked: who, and for how long. */
interface Asked {
  guests: string[];
  minutes: number;
}

/** A time with guests picked, waiting for Invite or Cancel: what the question named. */
export interface Inviting {
  question: string;
  /** Every guest by name, when the question names only some. */
  everyone?: string;
  at: DOMRect;
  s: Suggestion;
  people: string[];
  title: string;
}

export type Finder = ReturnType<typeof createFinder>;

/** Find a time over `range`, the days Calendar shows. */
export function createFinder(range: Accessor<Range>) {
  const [open, setOpen] = createSignal(false);
  const [who, setWhoNow] = createSignal("");
  const [title, setTitle] = createSignal("");
  const [minutes, setMinutesNow] = createSignal(DEFAULT_LENGTH);
  const [asked, setAsked] = createSignal<Asked>();
  const [inviting, setInviting] = createSignal<Inviting>();
  const [saving, setSaving] = createSignal(false);
  // Moves on with each Find, Close or change to what's asked: a save that comes back after one
  // leaves the new Find as it is.
  let round = 0;

  // Your own addresses aren't guests (the server leaves them out of find_time too).
  const setup = useAction<CalendarSetup>("calendar.calendars");
  const own = () => setup.data?.accounts.map((a) => a.email) ?? [];

  // Back at the window after a while: times that have begun since go at once.
  const [woke, setWoke] = createSignal(0);
  const wake = () => setWoke((n) => n + 1);
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  onCleanup(() => {
    window.removeEventListener("focus", wake);
    document.removeEventListener("visibilitychange", wake);
  });

  // Now is read when what's asked changes, not each minute, so the read isn't asked again.
  const ask = createMemo(() => {
    const a = asked();
    return a ? findInput(range(), a.minutes, a.guests, new Date()) : null;
  });
  const guests = () => asked()?.guests ?? [];
  const withGuests = () => ask()?.action === "calendar.find_time";
  const found = useAction<FoundTimes>(
    "calendar.find_time",
    () => ask()?.input,
    () => withGuests(),
  );
  const free = useAction<FreeSlot[]>(
    "calendar.free_time",
    () => ask()?.input,
    () => ask()?.action === "calendar.free_time",
  );
  /** The read for what was asked: find_time's, or free_time's. */
  const read = () => (withGuests() ? found : free);
  /** What was found, said the same way whichever was asked. */
  const result = createMemo((): FoundTimes | undefined => {
    if (withGuests()) return found.data;
    if (!free.data) return undefined;
    const known = knownFor(range(), daysOn(new Date(), 0));
    return { slots: free.data, checked: [], unseen: [], ...(known ? { knownUntil: known } : {}) };
  });
  const suggestions = createMemo(() => {
    const r = result();
    const a = asked();
    woke();
    return r && a ? suggest(r.slots, a.minutes, range(), { now: timeNow() }) : [];
  });

  /** What was found no longer answers what's typed: it goes, and nothing waits on it. */
  const forget = () => {
    round++;
    batch(() => {
      setAsked();
      setInviting();
    });
  };
  /** Asks about who's typed in Who, saying so if one of them isn't an address. */
  const find = () => {
    const { guests, bad } = readGuests(who(), own());
    if (bad.length) {
      toast.show(`“${bad[0]}” isn't an email address.`, "error");
      return;
    }
    round++;
    setAsked({ guests, minutes: minutes() });
  };
  const close = () => {
    forget();
    setOpen(false);
  };
  const done = () =>
    batch(() => {
      close();
      setWhoNow("");
      setTitle("");
    });

  /** A time that has begun: said, and the rest that have go too. */
  const begun = (s: Suggestion) => {
    if (s.start > new Date()) return false;
    toast.show("That time has passed. Find again for a later one.");
    wake();
    return true;
  };

  /** Adds it to your calendar, or invites `people` to it: just what was shown. */
  async function save(s: Suggestion, people: string[], name: string) {
    const at = round;
    const times = { title: name, start: s.start.toISOString(), end: s.end.toISOString() };
    setSaving(true);
    const made = await act<CalEvent>(
      people.length ? "calendar.schedule_meeting" : "calendar.create_event",
      people.length ? { ...times, attendees: people } : times,
    );
    setSaving(false);
    // act's toast says why it didn't.
    if (!made) return;
    const said = `${name}”: ${when(s.start, s.end)}.`;
    toast.show(people.length ? `Invited ${guestList(people)} to “${said}` : `Added “${said}`, "ok");
    if (at === round) done();
  }

  return {
    open,
    /** Opens Find a time, or keeps it open. */
    show: () => setOpen(true),
    close,
    who,
    /** Who changed: what was found for the guests before goes. */
    setWho(text: string) {
      batch(() => {
        setWhoNow(text);
        if (asked()) forget();
      });
    },
    title,
    setTitle,
    minutes,
    /** A new length: what was found for the old one goes. */
    setMinutes(m: number) {
      batch(() => {
        setMinutesNow(m);
        if (asked()) forget();
      });
    },
    find,
    asked,
    guests,
    /** Nothing to ask: the days shown have passed. */
    passed: () => asked() !== undefined && ask() === null,
    read,
    result,
    suggestions,
    inviting,
    /** A suggestion was clicked (`at`: where it is on screen). */
    pick(s: Suggestion, at: DOMRect) {
      if (saving()) return void toast.show("Still saving…");
      if (begun(s)) return;
      const people = guests();
      const name = titleFor(title(), people);
      if (!people.length) return void save(s, [], name);
      const all = everyone(people);
      setInviting({
        question: inviteQuestion(name, people, s),
        ...(all !== guestList(people) ? { everyone: all } : {}),
        at,
        s,
        people,
        title: name,
      });
    },
    /** Invite them, or not: those the question named, to what it named. */
    answer(yes: boolean) {
      const i = inviting();
      setInviting();
      if (!yes || !i) return;
      if (saving()) return void toast.show("Still saving…");
      if (!begun(i.s)) void save(i.s, i.people, i.title);
    },
  };
}
