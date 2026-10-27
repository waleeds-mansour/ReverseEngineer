// One line for many conversations one call of Pip's did the same way (a triage that archived 20,
// say), so Today isn't flooded: one Undo for all of them. Each conversation's own Undo
// (undo-mail.ts) still says whether it's as Pip left it, and the line's Undo puts back only those,
// saying how many it leaves as they are.
import type { Piece } from "./undo-mail-facts.ts";
import { manyWords, WHY_NOT } from "./undo-words.ts";

/** The pieces of one call's mail changes done the same way (the same op), as one. */
export function grouped(members: readonly Piece[]): Piece {
  const first = members[0]!;
  const open = members.filter((m) => m.reality === null);
  // None left as Pip left them: say you changed them if you changed any.
  const reality = open.length
    ? null
    : (members.find((m) => m.reality === WHY_NOT.youChanged) ?? first).reality;
  return {
    how: first.how,
    ...manyWords(first.op ?? "", members.length, open.length),
    inverse: open.flatMap((m) => [m.inverse].flat()),
    entityId: null,
    entityType: first.entityType,
    // The words are only counts: no subject, no sender.
    outside: false,
    reality,
    // Undone while what it put back stands, unless the call did more the same way since.
    stands: !open.length && members.some((m) => m.stands),
    old: first.old,
    op: first.op,
  };
}
