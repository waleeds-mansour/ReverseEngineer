// Over the box you ask Jarvis in: the record you have open, which goes with what you ask so "this"
// means it (lib/looking.ts). It says what it is by kind and title, so you see what Jarvis will
// take "this" to be; its x leaves it out.

import { Badge } from "../components/kit/Badge.tsx";
import { TYPE_LABEL } from "../lib/format.ts";
import { KIND_OF_VIEW, type Looking } from "../lib/looking.ts";
import { useAction } from "../lib/query.ts";
import type { Entity } from "../lib/types.ts";

/** The record's kind and title, as the chip says it: "Task · Book the dentist". */
export function useLookingRecord(looking: () => Looking | null) {
  const rec = useAction<Entity>(
    "entity.get",
    () => ({ id: looking()?.id }),
    () => !!looking(),
  );
  const type = () => rec.data?.type ?? KIND_OF_VIEW[looking()?.view ?? ""];
  return {
    type,
    label: () => {
      const kind = TYPE_LABEL[type() ?? ""] ?? "Record";
      const title = rec.data?.title?.trim();
      return title ? `${kind} · ${title}` : kind;
    },
  };
}

export function LookingChip(props: { label: string; onTakeOff: () => void }) {
  return (
    <Badge
      tone="accent"
      icon="paperclip"
      class="max-w-full"
      title="Pip is told you have this open, so “this” means it."
      onRemove={() => props.onTakeOff()}
      removeLabel="Leave it out"
    >
      <span class="min-w-0 truncate">{props.label}</span>
    </Badge>
  );
}
