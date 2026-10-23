// Pip's jobs (Spec 3), called roles in code (role.list): the shapes they come in, and their
// ceilings in words, for Settings and What Pip did.

export type RoleCeiling = "read" | "internal" | "self_external" | "outward";

export interface RoleView {
  id: string;
  name: string;
  description: string;
  personaNote: string | null;
  riskCeiling: RoleCeiling;
  /** Its own turns a day, inside Pip's; null when it shares Pip's alone. */
  turnsPerDay: number | null;
  active: boolean;
  turnsToday: number;
  routines: { id: string; title: string }[];
  reflexes: { name: string; description: string }[];
}

export interface AttachableReflex {
  name: string;
  description: string;
  roleId: string | null;
}

export interface RoleList {
  roles: RoleView[];
  reflexes: AttachableReflex[];
}

/** Each ceiling, lowest first: a word or two for its badge, and a line on what it lets through. */
export const CEILINGS: readonly { value: RoleCeiling; label: string; says: string }[] = [
  {
    value: "read",
    label: "Only reads",
    says: "Looks things up and tells you what it found. It changes nothing.",
  },
  {
    value: "internal",
    label: "In Nook",
    says: "Can also make and change things in Nook: tasks, notes, drafts.",
  },
  {
    value: "self_external",
    label: "Your accounts",
    says: "Can also change your own accounts, like your calendar. Nobody else sees it.",
  },
  {
    value: "outward",
    label: "Others see it",
    says: "Can also do what others see, asking you first as usual. Never what's hard to undo.",
  },
];

export const ceilingOf = (value: RoleCeiling) => CEILINGS.find((c) => c.value === value)!;

/** Its turns today, against its own allowance if it has one: "3 of 10 turns today". */
export function turnsWords(r: Pick<RoleView, "turnsToday" | "turnsPerDay">): string {
  const n = r.turnsToday;
  if (r.turnsPerDay === null) return `${n} ${n === 1 ? "turn" : "turns"} today`;
  return `${n} of ${r.turnsPerDay} turns today`;
}
