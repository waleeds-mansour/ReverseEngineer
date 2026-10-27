// Events moved by hand on Calendar. Each stays where it was dropped while Nook saves it, and till
// Calendar's first read after the save: if that read still has it at its old time, it goes back and
// a toast says so. A save that fails (its toast says why) or a Cancel puts back what was drawn
// before. A meeting with guests isn't saved on drop: moving it sends them an update, so Calendar
// asks first, beside where it was dropped.

import { type Accessor, createEffect, createMemo, createSignal, on } from "solid-js";
import { canDrag, guestCount, moveInput, type Span, sameSpan, spanOf } from "./calDrag.ts";
import { toast } from "./live.ts";
import { act } from "./query.ts";
import type { CalEvent } from "./types.ts";

interface Moved extends Span {
  /** Waiting for your yes (it has guests), being saved, or saved and not read back yet. */
  state: "asking" | "saving" | "saved";
  /** Its time as Calendar read it before this move. */
  was: Span;
  /** What was drawn before: an earlier move not read back yet, drawn again if this one fails. */
  prev?: Moved;
  /** When the save came back (ms): the first read after it settles the move. */
  savedAt?: number;
}

/** A meeting dropped somewhere new, waiting for Move or Cancel. */
export interface Asking {
  e: CalEvent;
  to: Span;
  /** Where it was dropped, on screen. */
  at: DOMRect;
  guests: number;
}

/**
 * `events`: what Calendar read; `readAt`: when that read last came back (the query's
 * dataUpdatedAt), which moves on even when nothing in it changed.
 */
export function createMoves(events: Accessor<readonly CalEvent[]>, readAt: Accessor<number>) {
  const [moved, setMoved] = createSignal<ReadonlyMap<string, Moved>>(new Map());
  const [asking, setAsking] = createSignal<Asking>();
  const put = (id: string, m?: Moved) =>
    setMoved((was) => {
      const next = new Map(was);
      if (m) next.set(id, m);
      else next.delete(id);
      return next;
    });

  // Each moved event drawn as the same object while it stays put, so its block isn't drawn again.
  let made = new Map<string, { from: CalEvent; key: string; out: CalEvent }>();
  /** The events as Calendar draws them: each one moved by hand where it was dropped. */
  const shown = createMemo(() => {
    const list = events();
    const m = moved();
    if (!m.size) return list;
    const kept = new Map<string, { from: CalEvent; key: string; out: CalEvent }>();
    const out = list.map((e) => {
      const x = m.get(e.id);
      if (!x) return e;
      const key = `${x.start.toISOString()} ${x.end.toISOString()}`;
      const was = made.get(e.id);
      const one =
        was?.from === e && was.key === key
          ? was.out
          : { ...e, startsAt: x.start.toISOString(), endsAt: x.end.toISOString() };
      kept.set(e.id, { from: e, key, out: one });
      return one;
    });
    made = kept;
    return out;
  });

  /**
   * A saved move is drawn from what Calendar read again once that read has it there, or once a
   * read after the save came back; one that still has the old time says so.
   */
  const settle = () => {
    for (const [id, x] of moved()) {
      if (x.state !== "saved") continue;
      const e = events().find((v) => v.id === id);
      const there = e && sameSpan(spanOf(e), x);
      if (e && !there && readAt() <= (x.savedAt ?? 0)) continue;
      put(id);
      if (e && !there && sameSpan(spanOf(e), x.was))
        toast.show(`“${e.title}” didn't move: Nook still has it at its old time.`, "error");
    }
  };
  createEffect(on([events, readAt], settle));

  /** This move didn't happen: what was drawn before it is drawn again. */
  const undo = (id: string, m: Moved | undefined) => {
    if (!m || moved().get(id) !== m) return;
    put(id, m.prev);
    settle();
  };

  async function save(e: CalEvent, m: Moved) {
    const { action, input } = moveInput(e, m);
    const done = await act<CalEvent>(action, input);
    // act's toast says why.
    if (!done) return undo(e.id, m);
    put(e.id, {
      start: new Date(done.startsAt),
      end: new Date(done.endsAt),
      state: "saved",
      was: m.was,
      savedAt: Date.now(),
    });
    settle();
    const guests = guestCount(e);
    if (guests)
      toast.show(`Moved. ${guests === 1 ? "Its guest gets" : "Its guests get"} an update.`, "ok");
  }

  return {
    shown,
    asking,
    /** Whether an event can be picked up now: not while its last move is still on its way. */
    can: (e: CalEvent) => canDrag(e) && (moved().get(e.id)?.state ?? "saved") === "saved",
    drop(e: CalEvent, to: Span, at: DOMRect) {
      if (sameSpan(to, spanOf(e))) return;
      const prev = moved().get(e.id);
      const read = events().find((v) => v.id === e.id) ?? e;
      const guests = guestCount(e);
      const m: Moved = {
        ...to,
        state: guests ? "asking" : "saving",
        was: spanOf(read),
        ...(prev ? { prev: { ...prev, prev: undefined } } : {}),
      };
      put(e.id, m);
      if (guests) setAsking({ e, to, at, guests });
      else void save(e, m);
    },
    /** Move (tell the guests), or put it back. */
    answer(yes: boolean) {
      const a = asking();
      if (!a) return;
      setAsking();
      const m = moved().get(a.e.id);
      if (!yes || !m) return undo(a.e.id, m);
      const saving: Moved = { ...m, state: "saving" };
      put(a.e.id, saving);
      void save(a.e, saving);
    },
  };
}
