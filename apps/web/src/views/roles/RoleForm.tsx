// A job's details, to make one or change it (Settings > Pip's jobs): its name, what it's for, its
// ceiling, its own turns a day and a few lines on how to go about it.

import { createSignal, For } from "solid-js";
import { Button } from "../../components/ui.tsx";
import { CEILINGS, ceilingOf, type RoleCeiling, type RoleView } from "../../lib/roles.ts";

export interface RoleFields {
  name: string;
  description: string;
  riskCeiling: RoleCeiling;
  /** Blank shares Pip's daily turns alone. */
  turnsPerDay: number | null;
  personaNote: string;
}

export const field = "rounded border border-line bg-panel px-2 py-1 text-sm";

export function RoleForm(props: {
  role?: RoleView;
  submit: string;
  onSubmit: (fields: RoleFields) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [name, setName] = createSignal(props.role?.name ?? "");
  const [description, setDescription] = createSignal(props.role?.description ?? "");
  const [ceiling, setCeiling] = createSignal<RoleCeiling>(props.role?.riskCeiling ?? "read");
  const [turns, setTurns] = createSignal(props.role?.turnsPerDay?.toString() ?? "");
  const [persona, setPersona] = createSignal(props.role?.personaNote ?? "");

  async function save(e: Event) {
    e.preventDefault();
    const n = turns().trim() === "" ? null : Math.max(0, Math.floor(Number(turns())));
    const done = await props.onSubmit({
      name: name(),
      description: description(),
      riskCeiling: ceiling(),
      turnsPerDay: Number.isFinite(n) ? n : null,
      personaNote: persona(),
    });
    if (done && !props.role) {
      setName("");
      setDescription("");
      setTurns("");
      setPersona("");
    }
  }

  return (
    <form class="space-y-2" onSubmit={(e) => void save(e)}>
      <div class="flex flex-wrap gap-2">
        <input
          class={`${field} min-w-40 flex-1`}
          placeholder="Name, like Inbox or Research"
          aria-label="Job name"
          maxLength={60}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
        />
        <select
          class={field}
          aria-label="The most it may do"
          value={ceiling()}
          onChange={(e) => setCeiling(e.currentTarget.value as RoleCeiling)}
        >
          <For each={CEILINGS}>{(c) => <option value={c.value}>{c.label}</option>}</For>
        </select>
        <input
          class={`${field} w-36`}
          type="number"
          min="0"
          max="500"
          placeholder="Turns a day"
          aria-label="Its own turns a day (blank shares Pip's)"
          value={turns()}
          onInput={(e) => setTurns(e.currentTarget.value)}
        />
      </div>
      <p class="text-meta text-muted">
        {ceilingOf(ceiling()).says} Anything more is held for your brief.
      </p>
      <input
        class={`${field} w-full`}
        placeholder="What it's for"
        aria-label="What it's for"
        maxLength={300}
        value={description()}
        onInput={(e) => setDescription(e.currentTarget.value)}
      />
      <textarea
        class={`${field} w-full`}
        rows={2}
        maxLength={500}
        placeholder="A few lines on how Pip goes about it (optional)"
        aria-label="How Pip goes about it"
        value={persona()}
        onInput={(e) => setPersona(e.currentTarget.value)}
      />
      <div class="flex gap-2">
        <Button variant="primary" onClick={(e) => void save(e)}>
          {props.submit}
        </Button>
        {props.onCancel && <Button onClick={() => props.onCancel?.()}>Cancel</Button>}
      </div>
    </form>
  );
}
