// Settings > Pip's jobs (Spec 3): profiles that only ever narrow what Pip does. A job takes on
// some of your routines and the things Pip does on its own; their turns then run within its
// ceiling and its own turns a day, with its few lines added. Anything past the ceiling is held for
// your brief. It's still one Pip, doing several jobs at once. Called roles in code (role.*).

import { createMemo, For, Show } from "solid-js";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import type { RoleList, RoleView } from "../lib/roles.ts";
import { RoleCard, type RoutineChoice } from "./roles/RoleCard.tsx";
import { type RoleFields, RoleForm } from "./roles/RoleForm.tsx";

export function RoleSettings() {
  const list = useAction<RoleList>("role.list");
  const routines = useAction<RoutineChoice[]>("routine.list");
  const roles = () => list.data?.roles ?? [];
  const jobName = createMemo(() => new Map(roles().map((r) => [r.id, r.name])));
  const routineJob = createMemo(
    () => new Map(roles().flatMap((r) => r.routines.map((x) => [x.id, r.id] as const))),
  );

  async function make(f: RoleFields) {
    const made = await act<RoleView>("role.create", {
      name: f.name,
      description: f.description,
      riskCeiling: f.riskCeiling,
      ...(f.turnsPerDay !== null ? { turnsPerDay: f.turnsPerDay } : {}),
      ...(f.personaNote.trim() ? { personaNote: f.personaNote } : {}),
    });
    if (made) toast.show(`Made ${made.name}. Add a routine or two to put it to work.`);
    return Boolean(made);
  }

  return (
    <section class="space-y-2">
      <h2 class="font-semibold">Pip's jobs</h2>
      <p class="text-sm text-muted">
        Give Pip a job: the routines and the things it does on its own that belong together, the
        most they may do, and how many turns a day they get. A job only ever narrows what Pip does;
        anything past it is held for your brief, never asked about.
      </p>
      <ul class="space-y-2">
        <For each={roles()}>
          {(r) => (
            <RoleCard
              role={r}
              routines={routines.data ?? []}
              reflexes={list.data?.reflexes ?? []}
              routineJob={routineJob()}
              jobName={jobName()}
            />
          )}
        </For>
      </ul>
      <Show when={list.data && roles().length === 0}>
        <p class="text-sm text-faint">No jobs yet.</p>
      </Show>
      <details class="rounded-md border border-line px-3 py-2">
        <summary class="cursor-pointer text-sm font-medium">New job</summary>
        <div class="pt-2">
          <RoleForm submit="Make job" onSubmit={make} />
        </div>
      </details>
    </section>
  );
}
