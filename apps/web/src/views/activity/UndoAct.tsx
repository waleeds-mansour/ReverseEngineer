// The Undo on one thing Pip did without asking, the same on Today and in What Pip did: one press,
// whose words say exactly what it puts back (lib/pipUndo.ts). One that tells someone else (taking
// back a yes tells its organizer) says so beside it, where a phone shows it too. Once it can't any
// more (undone, too old, changed since) it's greyed, with why. Pressing it doesn't open the row.

import { createEffect, createSignal, on, Show } from "solid-js";
import { OutsideMark } from "../../components/OutsideMark.tsx";
import { Button } from "../../components/ui.tsx";
import { ago } from "../../lib/format.ts";
import { type Undid, type UndoView, undoIt } from "../../lib/pipUndo.ts";

export function UndoAct(props: { undo: UndoView }) {
  const [busy, setBusy] = createSignal(false);
  // Pressed here, until the list is read again and says so itself.
  const [pressed, setPressed] = createSignal(false);
  createEffect(
    on(
      () => props.undo,
      () => setPressed(false),
      { defer: true },
    ),
  );
  const why = () => props.undo.blocked ?? (pressed() ? "Undone" : null);
  const press = async () => {
    setBusy(true);
    if (await undoIt(props.undo)) setPressed(true);
    setBusy(false);
  };
  return (
    <span class="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
      <Show when={why()}>{(w) => <span class="text-meta text-faint">{w()}</span>}</Show>
      <Show when={!why() && props.undo.tells}>
        {(t) => <span class="text-meta text-warn">{t()}</span>}
      </Show>
      <Button
        size="sm"
        icon="undo-2"
        label={why() ? `${props.undo.label}: ${why()}` : props.undo.label}
        title={why() ?? props.undo.label}
        disabled={busy() || why() !== null}
        onClick={() => void press()}
      >
        Undo
      </Button>
    </span>
  );
}

/** A card of What Pip did for an Undo you pressed. */
export function UndidCard(props: { undid: Undid; at: string }) {
  return (
    <li class="border-b border-line py-3">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="min-w-0 flex-1">
          <span class="font-medium">You undid: </span>
          {props.undid.did}
        </span>
        <Show when={props.undid.outside}>
          <OutsideMark>Outside content</OutsideMark>
        </Show>
        <span class="text-xs text-faint tabular-nums">{ago(props.at)}</span>
      </div>
    </li>
  );
}
