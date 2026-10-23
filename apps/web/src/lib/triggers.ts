// Your triggers (Spec 6, trigger.list): the shapes they come in, and what each waits for and how
// its day is going, in words, for Settings.

import { ago } from "./format.ts";

export interface TriggerField {
  key: string;
  label: string;
  values?: { value: string; label: string }[];
  hint?: string;
}

export interface TriggerKindView {
  kind: string;
  label: string;
  fields: TriggerField[];
}

export interface TriggerView {
  id: string;
  name: string;
  on: string;
  onLabel: string;
  filter: Record<string, string>;
  instructions: string;
  roleId: string | null;
  /** The job's name, while it has one. */
  job: string | null;
  perDay: number;
  firedToday: number;
  lastFiredAt: string | null;
  active: boolean;
}

export interface TriggerList {
  triggers: TriggerView[];
  kinds: TriggerKindView[];
}

/** What it waits for, after "When": "an email arrives · From: ana@acme.com". */
export function waitsFor(
  t: Pick<TriggerView, "on" | "onLabel" | "filter">,
  kinds: TriggerKindView[],
) {
  const kind = kinds.find((k) => k.kind === t.on);
  const parts = Object.entries(t.filter).map(([key, value]) => {
    const field = kind?.fields.find((f) => f.key === key);
    const shown = field?.values?.find((v) => v.value === value.toLowerCase())?.label ?? value;
    return `${field?.label ?? key}: ${shown}`;
  });
  const label = t.onLabel.charAt(0).toLowerCase() + t.onLabel.slice(1);
  return [label, ...parts].join(" · ");
}

/** How its day is going: "2 of 10 turns today, last 5m ago", or that it's resting till tomorrow. */
export function firedWords(t: Pick<TriggerView, "firedToday" | "perDay" | "lastFiredAt">): string {
  if (t.firedToday >= t.perDay)
    return `Started its ${t.perDay} turns today; resting until tomorrow`;
  const today = `${t.firedToday} of ${t.perDay} turns today`;
  return t.lastFiredAt ? `${today}, last ${ago(t.lastFiredAt)}` : `${today}, never fired yet`;
}
