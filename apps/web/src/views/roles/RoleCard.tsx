// One of Pip's jobs in Settings: what it's for, the most it may do, the turns it spent today, and
// what's in it (routines, things Pip does on its own, triggers), with a way to add a routine or
// something Pip does on its own, or take one out.

import { createSignal, For, Show } from "solid-js";
import { Badge, Button, TextButton } from "../../components/ui.tsx";
import { toast } from "../../lib/live.ts";
import { act } from "../../lib/query.ts";
import { type AttachableReflex, ceilingOf, type RoleView, turnsWords } from "../../lib/roles.ts";
import { field, type RoleFields, RoleForm } from "./RoleForm.tsx";

export interface RoutineChoice {
  id: string;
  title: string;
}

export function RoleCard(props: {
  role: RoleView;
  routines: RoutineChoice[];
  reflexes: AttachableReflex[];
  /** The job each routine is in, by routine id, and each job's name, by id. */
  routineJob: Map<string, string>;
  jobName: Map<string, string>;
}) {
  const r = () => props.role;
  const [editing, setEditing] = createSignal(false);
  const elsewhere = (roleId: string | null | undefined) =>
    roleId && roleId !== r().id ? ` (now in ${props.jobName.get(roleId) ?? "another job"})` : "";
  const choices = () => [
    ...props.routines
      .filter((x) => props.routineJob.get(x.id) !== r().id)
      .map((x) => ({
        key: `routine:${x.id}`,
        label: `Routine: ${x.title}${elsewhere(props.routineJob.get(x.id))}`,
      })),
    ...props.reflexes
      .filter((x) => x.roleId !== r().id)
      .map((x) => ({ key: `reflex:${x.name}`, label: `${x.description}${elsewhere(x.roleId)}` })),
  ];

  async function attach(key: string) {
    const [kind, value] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    const input = kind === "routine" ? { routineId: value } : { reflex: value };
    if (await act("role.attach", { id: r().id, ...input }))
      toast.show(`Added to ${r().name}. Its turns now run within this job.`);
  }

  async function save(f: RoleFields) {
    const done = await act("role.update", {
      id: r().id,
      ...f,
      personaNote: f.personaNote.trim() || null,
    });
    if (done) setEditing(false);
    return Boolean(done);
  }

  return (
    <li class="space-y-2 rounded-md bg-sunk px-3 py-2 text-sm" data-role={r().name}>
      <Show
        when={!editing()}
        fallback={
          <RoleForm role={r()} submit="Save" onSubmit={save} onCancel={() => setEditing(false)} />
        }
      >
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium">{r().name}</span>
          <Badge tone="accent">{ceilingOf(r().riskCeiling).label}</Badge>
          <Badge tone={r().active ? "positive" : "neutral"}>{r().active ? "On" : "Off"}</Badge>
          <span class="min-w-32 flex-1 text-xs text-faint tabular-nums">{turnsWords(r())}</span>
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button
            size="sm"
            onClick={() => void act("role.update", { id: r().id, active: !r().active })}
          >
            {r().active ? "Turn off" : "Turn on"}
          </Button>
          <Button size="sm" tone="danger" onClick={() => void act("role.remove", { id: r().id })}>
            Remove
          </Button>
        </div>
        <Show when={r().description}>
          <p class="text-muted">{r().description}</p>
        </Show>
        <Show when={r().personaNote}>
          <p class="text-meta text-muted italic">“{r().personaNote}”</p>
        </Show>
      </Show>
      <ul class="space-y-0.5">
        <For each={r().routines}>
          {(x) => (
            <li class="flex items-center gap-2">
              <span class="flex-1">Routine: {x.title}</span>
              <TextButton
                alone
                onClick={() => void act("role.detach", { id: r().id, routineId: x.id })}
              >
                Take out
              </TextButton>
            </li>
          )}
        </For>
        <For each={r().reflexes}>
          {(x) => (
            <li class="flex items-center gap-2">
              <span class="flex-1">{x.description}</span>
              <TextButton
                alone
                onClick={() => void act("role.detach", { id: r().id, reflex: x.name })}
              >
                Take out
              </TextButton>
            </li>
          )}
        </For>
        <For each={r().triggers}>
          {(x) => (
            <li class="flex items-center gap-2">
              <span class="flex-1">Trigger: {x.name}</span>
              <TextButton
                alone
                onClick={() => void act("trigger.update", { id: x.id, roleId: null })}
              >
                Take out
              </TextButton>
            </li>
          )}
        </For>
      </ul>
      <Show when={r().routines.length + r().reflexes.length + r().triggers.length === 0}>
        <p class="text-faint">Nothing in it yet, so it changes nothing.</p>
      </Show>
      <Show when={choices().length > 0}>
        <select
          class={`${field} w-full`}
          aria-label={`Add to ${r().name}`}
          value=""
          onChange={(e) => {
            const key = e.currentTarget.value;
            e.currentTarget.value = "";
            if (key) void attach(key);
          }}
        >
          <option value="">Add a routine, or something Pip does on its own…</option>
          <For each={choices()}>{(c) => <option value={c.key}>{c.label}</option>}</For>
        </select>
      </Show>
    </li>
  );
}
