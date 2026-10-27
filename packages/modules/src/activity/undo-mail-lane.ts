// Undo for a sender Pip sent to Signal or Noise on its own (mail/lanes.ts): their rule goes back to
// what it was, or away, and the conversations it moved go back (mail.lane_back), at most the first
// MOVED_BACK of them, which its words say. Greyed once their rule is changed or forgotten since.
import { isUuid } from "@hearth/core";
import type { Change } from "./undo-facts.ts";
import {
  changedSince,
  isLane,
  type MailFacts,
  type Piece,
  str,
  strings,
} from "./undo-mail-facts.ts";
import { laneWords, WHY_NOT } from "./undo-words.ts";

export function lanePiece(e: Change, f: MailFacts): Piece | null {
  const p = e.payload;
  const pattern = str(p.pattern);
  const was = p.was ?? null;
  if (!pattern || !isLane(p.lane) || (was !== null && !isLane(was))) return null;
  const threads = strings(p.threads).filter(isUuid);
  if (was === p.lane && !threads.length) return null;
  // All it moved, though only the first MOVED_BACK are kept for its Undo.
  const moved = typeof p.moved === "number" ? Math.max(p.moved, threads.length) : threads.length;
  const rule = f.rules.get(pattern);
  const back = was === null ? !rule : rule === was;
  // Only you can forget a rule (mail.remove_rule), so one that's gone you forgot. Setting the same
  // lane again changes nothing, so it doesn't stop Undo.
  const reality = !rule
    ? WHY_NOT.youChanged
    : (changedSince(
        f,
        e,
        (l) => l.payload.pattern === pattern,
        () => true,
      ) ?? (rule === p.lane ? null : WHY_NOT.changed));
  return {
    how: "changed",
    ...laneWords(pattern, p.lane, was, threads.length, moved),
    inverse: { action: "mail.lane_back", input: { pattern, lane: p.lane, rule: was, threads } },
    entityId: null,
    entityType: null,
    // A sender's address, from their mail (D58).
    outside: true,
    reality,
    stands: back,
  };
}
