// A new trigger (Settings > Triggers): its name, the kind of event it waits for, the fields that
// narrow it (blank is any), what Pip should do in your words, the job it runs for, and how many
// turns it may start a day.

import { createSignal, For, Show } from "solid-js";
import { Button } from "../../components/ui.tsx";
import type { RoleView } from "../../lib/roles.ts";
import type { TriggerKindView } from "../../lib/triggers.ts";

export interface TriggerFields {
  name: string;
  on: string;
  filter: Record<string, string>;
  instructions: string;
  roleId: string | null;
  perDay: number;
}

const field = "rounded border border-line bg-panel px-2 py-1 text-sm";

export function TriggerForm(props: {
  kinds: TriggerKindView[];
  jobs: Pick<RoleView, "id" | "name">[];
  onSubmit: (fields: TriggerFields) => Promise<boolean>;
}) {
  const [name, setName] = createSignal("");
  const [on, setOn] = createSignal(props.kinds[0]?.kind ?? "mail.received");
  const [filter, setFilter] = createSignal<Record<string, string>>({});
  const [instructions, setInstructions] = createSignal("");
  const [roleId, setRoleId] = createSignal("");
  const [perDay, setPerDay] = createSignal(10);
  const kind = () => props.kinds.find((k) => k.kind === on());
  const narrow = (key: string, value: string) =>
    setFilter((f) => {
      const { [key]: _was, ...rest } = f;
      return value.trim() ? { ...rest, [key]: value.trim() } : rest;
    });

  async function save(e: Event) {
    e.preventDefault();
    const done = await props.onSubmit({
      name: name(),
      on: on(),
      filter: filter(),
      instructions: instructions(),
      roleId: roleId() || null,
      perDay: perDay(),
    });
    if (done) {
      setName("");
      setFilter({});
      setInstructions("");
    }
  }

  return (
    <form class="space-y-2" onSubmit={(e) => void save(e)}>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span>When</span>
        <select
          class={`${field} max-w-full`}
          aria-label="When this happens"
          value={on()}
          onChange={(e) => {
            setOn(e.currentTarget.value);
            setFilter({});
          }}
        >
          <For each={props.kinds}>{(k) => <option value={k.kind}>{k.label}</option>}</For>
        </select>
        <For each={kind()?.fields ?? []}>
          {(f) => (
            <Show
              when={f.values}
              fallback={
                <input
                  class={`${field} min-w-48 flex-1`}
                  placeholder={`${f.label}: ${f.hint ?? "any"}`}
                  aria-label={f.label}
                  value={filter()[f.key] ?? ""}
                  onInput={(e) => narrow(f.key, e.currentTarget.value)}
                />
              }
            >
              {(values) => (
                <select
                  class={field}
                  aria-label={f.label}
                  value={filter()[f.key] ?? ""}
                  onChange={(e) => narrow(f.key, e.currentTarget.value)}
                >
                  <option value="">{f.label}: any</option>
                  <For each={values()}>
                    {(v) => (
                      <option value={v.value}>
                        {f.label}: {v.label}
                      </option>
                    )}
                  </For>
                </select>
              )}
            </Show>
          )}
        </For>
      </div>
      <textarea
        class={`${field} w-full`}
        rows={3}
        maxLength={4000}
        placeholder="What Pip should do, in your words"
        aria-label="What Pip should do"
        value={instructions()}
        onInput={(e) => setInstructions(e.currentTarget.value)}
      />
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <input
          class={`${field} min-w-40 flex-1`}
          placeholder="Name, like Acme emails"
          aria-label="Trigger name"
          maxLength={80}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <select
          class={field}
          aria-label="The job it runs for"
          value={roleId()}
          onChange={(e) => setRoleId(e.currentTarget.value)}
        >
          <option value="">No job</option>
          <For each={props.jobs}>{(j) => <option value={j.id}>Job: {j.name}</option>}</For>
        </select>
        <label class="flex items-center gap-1">
          <input
            class={`${field} w-16`}
            type="number"
            min="1"
            max="50"
            aria-label="Most turns a day"
            value={perDay()}
            onInput={(e) =>
              setPerDay(Math.min(50, Math.max(1, Number(e.currentTarget.value) || 10)))
            }
          />
          <span class="text-muted">a day at most</span>
        </label>
        <Button variant="primary" onClick={(e) => void save(e)}>
          Add trigger
        </Button>
      </div>
    </form>
  );
}
