// Undo for what Pip did without asking (activity.undos, activity.undo): one list the server reads
// for Today's What I did and each card of What Pip did, so the two always say the same. Its words
// come from the server: what Pip did, what pressing Undo does, or why it can't any more.

import { toast } from "./live.ts";
import { act } from "./query.ts";
import { restore } from "./trash.ts";

/** Which thing to put back: the event Pip's call left, or the calendar's note about it. */
export type UndoRef = { kind: "event"; id: string } | { kind: "notification"; id: string };

export interface UndoView {
  ref: UndoRef;
  /** The card of What Pip did it's on. */
  groupId: string | null;
  at: string;
  how: "made" | "trashed" | "changed";
  /** "Made a task: Call the plumber". */
  did: string;
  /** 'Undo: move "Call the plumber" to the trash'. */
  label: string;
  /** Who pressing it tells, said beside the button: "Its organizer will see". */
  tells: string | null;
  /** Why it can't be undone now (undone, too old, changed since), or null when it can. */
  blocked: string | null;
  /** You pressed its Undo, and what it put back still stands. */
  undone: boolean;
  entityId: string | null;
  entityType: string | null;
  /** Its words are outside content's (D58). */
  outside: boolean;
}

/** A card of What Pip did for an Undo you pressed. */
export interface Undid {
  did: string;
  entityId: string | null;
  entityType: string | null;
  outside: boolean;
}

/**
 * Puts one thing back. What Pip made goes to the trash, so the toast can bring it back again.
 * Returns false when it didn't go through (the error shows as a toast).
 */
export async function undoIt(u: Pick<UndoView, "ref" | "did" | "how" | "entityId">) {
  const r = await act<{ did: string }>("activity.undo", { ref: u.ref });
  if (!r) return false;
  const id = u.how === "made" ? u.entityId : null;
  toast.show(
    `You undid: ${r.did}`,
    "info",
    id ? { label: "Undo", run: () => void restore(id) } : undefined,
  );
  return true;
}
