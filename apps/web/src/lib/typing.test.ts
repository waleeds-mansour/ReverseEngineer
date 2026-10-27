import { describe, expect, it } from "vitest";
import { type Field, TYPING_MS, watchTyping } from "./typing.ts";
import { reloadOnReturn, wouldLoseWork } from "./version.ts";

type Box = Field & { type: string; readOnly?: boolean; disabled?: boolean };
const page = (...fields: Box[]) =>
  ({ querySelectorAll: () => fields }) as unknown as Pick<ParentNode, "querySelectorAll">;
const empty = (type: string): Box => ({ type, value: "", defaultValue: "" });
/** What Nook put in a field itself: set as the field's value, as Solid does, not in its markup. */
const filled = (value: string): Box => ({ ...empty("textarea"), value });

/** A page's typing, on a clock the test moves; `type` is you pressing keys. */
function owner() {
  let at = 1_000_000;
  const heard: Record<string, (e: Event) => void> = {};
  const win = {
    addEventListener: (kind: string, fn: (e: Event) => void) => {
      heard[kind] = fn;
    },
  } as unknown as EventTarget;
  const typed = watchTyping(win, () => at);
  const fire = (kind: string, target: object, isTrusted: boolean) =>
    heard[kind]!({ target, isTrusted } as unknown as Event);
  return {
    typed,
    /** Adds `text` to a field (or types where there's no field: a note, a card). */
    type(target: object, text: string, isTrusted = true) {
      fire("beforeinput", target, isTrusted);
      if ("value" in target) (target as Field).value += text;
      fire("input", target, isTrusted);
    },
    later: (ms: number) => {
      at += ms;
    },
  };
}
const loses = (o: ReturnType<typeof owner>, ...fields: Box[]) =>
  wouldLoseWork(new EventTarget(), page(...fields), o.typed);

describe("whether reloading would lose something", () => {
  it("loses nothing when no field has anything in it and nothing's waiting to be saved", () => {
    const o = owner();
    expect(loses(o, empty("text"), empty("search"), empty("textarea"))).toBe(false);
    expect(loses(o)).toBe(false);
  });

  it("doesn't count what Nook filled in itself: a draft brought back, a field filled in", () => {
    const o = owner();
    const draft = filled("Thanks, see you Friday");
    const name = { ...empty("text"), value: "Groceries" };
    expect(loses(o, draft, name)).toBe(false);
    // Nor events Nook sends itself: only the browser's own say you typed.
    o.type(draft, "!", false);
    expect(loses(o, draft, name)).toBe(false);
  });

  it("would lose text you typed into a field, after a pause too", () => {
    const o = owner();
    const field = empty("text");
    o.type(field, "Buy milk");
    expect(loses(o, empty("search"), field)).toBe(true);
    o.later(10 * TYPING_MS);
    expect(loses(o, empty("search"), field)).toBe(true);
    // Added (Nook emptied the field), it's safe.
    field.value = "";
    expect(loses(o, field)).toBe(false);
  });

  it("would lose a change to what Nook filled in, but not that text put back", () => {
    const o = owner();
    const draft = filled("Thanks");
    o.type(draft, ", see you");
    o.later(TYPING_MS);
    expect(loses(o, draft)).toBe(true);
    draft.value = "Thanks";
    expect(loses(o, draft)).toBe(false);
  });

  it("waits while you're typing anywhere, and not once you've stopped a while", () => {
    const o = owner();
    // A note or a card: not a field, but typing all the same.
    o.type({}, "a");
    o.later(2_000);
    expect(loses(o)).toBe(true);
    o.later(TYPING_MS);
    expect(loses(o)).toBe(false);
  });

  it("doesn't count boxes, buttons and fields you can't type into", () => {
    const o = owner();
    const fields = [
      { ...empty("checkbox"), value: "on" },
      { ...empty("hidden"), value: "token" },
      { ...empty("range"), value: "50" },
      { ...empty("text"), readOnly: true },
      { ...empty("text"), disabled: true },
    ];
    for (const f of fields) o.type(f, "x");
    o.later(TYPING_MS);
    expect(loses(o, ...fields)).toBe(false);
  });

  it("asks the page's own leave-this-page guards, as the browser does", () => {
    const win = new EventTarget();
    let unsaved = true;
    win.addEventListener("beforeunload", (e) => {
      if (unsaved) e.preventDefault();
    });
    const { typed } = owner();
    expect(wouldLoseWork(win, page(), typed)).toBe(true);
    unsaved = false;
    expect(wouldLoseWork(win, page(), typed)).toBe(false);
  });
});

describe("an update while Nook has filled fields in", () => {
  const newer = { build: "def", migrations: { ok: true } };
  const reloadsInto = (o: ReturnType<typeof owner>, ...fields: Box[]) =>
    reloadOnReturn("updated", newer, null, () => loses(o, ...fields));

  it("goes ahead when you've pressed no keys", () => {
    const o = owner();
    expect(reloadsInto(o, filled("Kept draft"), { ...empty("email"), value: "me@x" })).toBe("def");
  });

  it("waits when you typed a couple of seconds ago", () => {
    const o = owner();
    const note = {};
    o.type(note, "Call Ana");
    o.later(2_000);
    expect(reloadsInto(o, filled("Kept draft"))).toBeNull();
    o.later(TYPING_MS);
    expect(reloadsInto(o, filled("Kept draft"))).toBe("def");
  });
});
