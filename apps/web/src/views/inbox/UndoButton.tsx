// The Undo on Jarvis's note about something it did on its own (D71, D72): one press, which says
// exactly what it puts back. It goes through activity.undo, as every Undo of Pip's does, so What
// Pip did and Today show it as undone too, and it asks the server the same way they do whether it
// still can: greyed with why once the event has changed since (you moved it, put it back,
// answered it). Pressing it doesn't open the row.

import { createSignal, Show } from "solid-js";
import { Button } from "../../components/ui.tsx";
import { type UndoView, undoIt } from "../../lib/pipUndo.ts";
import { useAction } from "../../lib/query.ts";
import type { InboxRow } from "../../lib/types.ts";
import { undoLabel } from "../../lib/undo.ts";

export function UndoButton(props: { row: InboxRow }) {
  const [busy, setBusy] = createSignal(false);
  const n = () => props.row.notification;
  const label = () => undoLabel(props.row);
  const ref = () => ({ kind: "notification" as const, id: n().id });
  const state = useAction<UndoView[]>(
    "activity.undos",
    () => ({ ref: ref() }),
    () => label() !== null,
  );
  // Until the server says, as the note says; then as the server will take it.
  const view = () => (state.data ? (state.data[0] ?? null) : undefined);
  const why = () => view()?.blocked ?? null;
  const undo = async () => {
    setBusy(true);
    await undoIt({ ref: ref(), did: n().title, how: "changed", entityId: n().entityId });
    setBusy(false);
  };
  return (
    <Show when={view() === null ? null : label()}>
      {(text) => (
        <div class="mt-2 flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            wrap
            disabled={busy() || why() !== null}
            title={why() ?? undefined}
            onClick={() => void undo()}
          >
            {view()?.label ?? text()}
          </Button>
          <Show when={why()}>{(w) => <span class="text-meta text-faint">{w()}</span>}</Show>
        </div>
      )}
    </Show>
  );
}
