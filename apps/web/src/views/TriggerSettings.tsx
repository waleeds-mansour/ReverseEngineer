// Settings > Triggers (Spec 6): when something you picked happens (an email from someone, a task
// that's yours, a pull request), Pip does what you wrote, on its own. Each gets a turn at most so
// many times a day, for the job you name if any, and stops while Pip is paused. You can also ask
// Pip in chat ("whenever Ana emails, draft a reply") and it makes one here.

import { For, Show } from "solid-js";
import { Badge, Button } from "../components/ui.tsx";
import { toast } from "../lib/live.ts";
import { act, useAction } from "../lib/query.ts";
import type { RoleList } from "../lib/roles.ts";
import { firedWords, type TriggerList, type TriggerView, waitsFor } from "../lib/triggers.ts";
import { type TriggerFields, TriggerForm } from "./triggers/TriggerForm.tsx";

export function TriggerSettings() {
  const list = useAction<TriggerList>("trigger.list");
  const roles = useAction<RoleList>("role.list");
  const triggers = () => list.data?.triggers ?? [];
  const kinds = () => list.data?.kinds ?? [];

  async function add(f: TriggerFields) {
    const made = await act<TriggerView>("trigger.create", {
      name: f.name,
      on: f.on,
      filter: f.filter,
      instructions: f.instructions,
      perDay: f.perDay,
      ...(f.roleId ? { roleId: f.roleId } : {}),
    });
    if (made) toast.show(`"${made.name}" is on: when ${waitsFor(made, kinds())}.`);
    return Boolean(made);
  }

  return (
    <section class="space-y-2">
      <h2 class="font-semibold">Triggers</h2>
      <p class="text-sm text-muted">
        When something you pick happens, Pip does what you wrote, on its own. Anything that would
        send something still waits for your yes, and a job caps what it may do.
      </p>
      <ul class="space-y-1">
        <For each={triggers()}>
          {(t) => (
            <li class="space-y-1 rounded-md bg-sunk px-3 py-2 text-sm" data-trigger={t.name}>
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{t.name}</span>
                <Show when={t.job}>{(job) => <Badge tone="accent">{job()}</Badge>}</Show>
                <Badge tone={t.active ? "positive" : "neutral"}>{t.active ? "On" : "Paused"}</Badge>
                <span class="min-w-40 flex-1 text-xs text-faint tabular-nums">{firedWords(t)}</span>
                <Button
                  size="sm"
                  onClick={() => void act("trigger.update", { id: t.id, active: !t.active })}
                >
                  {t.active ? "Pause" : "Turn on"}
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  onClick={() => void act("trigger.remove", { id: t.id })}
                >
                  Remove
                </Button>
              </div>
              <p class="text-meta text-muted">When {waitsFor(t, kinds())}</p>
              <p class="whitespace-pre-wrap text-muted">{t.instructions}</p>
            </li>
          )}
        </For>
      </ul>
      <Show when={list.data && triggers().length === 0}>
        <p class="text-sm text-faint">No triggers yet.</p>
      </Show>
      <Show when={kinds().length > 0}>
        <details class="rounded-md border border-line px-3 py-2">
          <summary class="cursor-pointer text-sm font-medium">New trigger</summary>
          <div class="pt-2">
            <TriggerForm kinds={kinds()} jobs={roles.data?.roles ?? []} onSubmit={add} />
          </div>
        </details>
      </Show>
    </section>
  );
}
