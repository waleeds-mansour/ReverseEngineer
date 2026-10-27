// Which cached reads a change can affect, so a live event or a change you made refreshes only
// those screens instead of every list at once.
//
// A cached read's key is [action name, input]. A rule lists action names, or whole modules as
// "mail." (every read whose name starts with it). No rule (null) means "refresh everything",
// which is what anything not listed here gets, so a new event kind is never left stale.

export type Rule = readonly string[];

const MAIL: Rule = ["mail.", "person.view", "company.view"];

/** By the event's kind, before its module's rule. */
const BY_KIND: Record<string, Rule> = {
  // A change to your mail can grey an Undo of what Pip did to it, or be one (Today lists them).
  "mail.changed": [...MAIL, "activity.undos"],
};

/** By the event's module: the part of its kind before the first dot. */
const BY_MODULE: Record<string, Rule> = {
  // A channel Jarvis stopped answering in tells you with a card (D62). A note of Pip's about your
  // calendar comes with an Undo, which Today lists.
  notification: ["inbox.list", "slack.channels", "activity.undos"],
  // What Pip did lists each approval, and how it went.
  approval: [
    "inbox.list",
    "approval.list",
    "conversation.",
    "activity.",
    "standing_rule.list",
    // A held reply to someone in Slack shows on their conversation's bar (D62).
    "slack.conversation",
    "slack.conversations",
  ],
  link: ["entity.", "task.", "note.list", "person.view", "company.view", "doc."],
  mail: MAIL,
  // What Pip changed on a task has an Undo, which a later change greys.
  task: ["task.", "inbox.list", "activity."],
  // An Undo on an inbox line (D71, D72) puts the line away, and an event moved since greys it.
  calendar: ["calendar.", "person.view", "company.view", "inbox.list", "activity.undos"],
  // A Slack member's conversation growing shows on the Slack screens too (D62). A turn's
  // conversation grows as it works, so What Pip did fills in its card as it goes.
  conversation: [
    "conversation.",
    "jarvis.activity",
    "activity.",
    "slack.conversation",
    "slack.conversations",
  ],
  chat: ["conversation.", "jarvis.activity", "activity."],
  // A turn that ended may have set or cancelled a reminder, which says nothing of its own. A
  // job's turns today, and a trigger's, count in Settings.
  jarvis: [
    "jarvis.",
    "role.list",
    "trigger.list",
    "activity.",
    "observation.list",
    "system.status",
    "conversation.",
    "reminder.list",
  ],
  system: ["system.status"],
  memory: ["memory.", "activity."],
  // An Undo pressed elsewhere (another browser, the phone) shows as undone here.
  activity: ["activity.", "jarvis.did", "inbox.list"],
  page_watch: ["page_watch."],
  browser: ["browser.", "vault.logins"],
  vault: ["vault.", "browser.sites"],
  slack: ["slack."],
  github: ["github."],
  notion: ["notion."],
  data: ["data."],
  // Pip's jobs (Spec 3): What Pip did filters by them, and a trigger names its job.
  role: ["role.", "activity.", "trigger.list"],
  // Your triggers (Spec 6), which a job lists.
  trigger: ["trigger.", "role.list"],
  voice: ["dictation.", "dictionary.", "voice.", "snippet."],
  meeting: ["meeting."],
  // A schedule firing moves a routine's "last ran", and a reminder that rang leaves the list.
  clock: ["routine.list", "system.status", "reminder.list"],
};

/**
 * A record change can show anywhere it's linked or titled, and in what Jarvis did when Jarvis made
 * it (a routine's prep, say, outside any turn)...
 */
const ANY_RECORD: Rule = [
  "entity.",
  "inbox.list",
  "person.view",
  "company.view",
  "doc.",
  "jarvis.did",
];

/**
 * ...and, for what Pip makes and trashes, with its Undo on Today and in What Pip did, which a
 * change can grey. Not mail or events, which their syncs change all day, but a draft Pip threw
 * away, which its Undo brings back.
 */
const UNDOABLE = new Set([
  "note",
  "task",
  "canvas",
  "spreadsheet",
  "person",
  "company",
  "meeting",
  "page_watch",
  "memory_note",
  "comment",
  "brief",
  "journal",
  "conversation",
  "snippet",
  "email_draft",
]);

/** ...and in the lists of its own type. */
const BY_TYPE: Record<string, Rule> = {
  task: ["task."],
  // A Notion import is a note; Settings lists them.
  note: ["note.list", "notion.imports"],
  canvas: ["canvas."],
  spreadsheet: ["sheet."],
  person: ["person.", "company."],
  company: ["company.", "person."],
  meeting: ["meeting."],
  conversation: ["conversation."],
  comment: ["comment.list"],
  brief: [],
  journal: [],
  agent: [],
  prep: ["calendar."],
  page_watch: ["page_watch."],
  memory_note: ["memory."],
  event: ["calendar."],
  routine: ["routine.list"],
  email_thread: MAIL,
  email: MAIL,
  email_draft: ["mail.drafts"],
  snippet: ["snippet.list"],
  slack_message: ["slack."],
  github_pr: ["github."],
  notion_task: ["notion."],
};

/** Reads a change made through an action can affect, beyond its own module's. */
const AFTER_CHANGE: Record<string, Rule> = {
  google: ["mail.", "calendar."],
  jarvis: ["system.status", "observation.list", "activity."],
  note: ["task.", "doc."],
  person: ["company.", "task."],
  company: ["person."],
  doc: ["note.list", "entity."],
  routine: ["system.status", "role.list"],
  role: ["activity.", "trigger.list"],
  trigger: ["role.list"],
  // Settings → Coming up lists them.
  reminder: ["system.status"],
  approval: ["inbox.list", "conversation.", "activity."],
  standing_rule: ["approval.list"],
  // Jarvis's Slack bot holds the standing rule that lets its replies to members go out (D62).
  slack: ["standing_rule.list"],
};

const moduleOf = (name: string) => name.split(".", 1)[0] ?? "";

/** The reads a live event can change; null for all of them. */
export function affectedBy(e: { kind: string; payload?: Record<string, unknown> }): Rule | null {
  const module = moduleOf(e.kind);
  if (module === "entity") {
    const type = typeof e.payload?.type === "string" ? e.payload.type : null;
    const own = type === null ? undefined : BY_TYPE[type];
    if (!own) return null;
    return type && UNDOABLE.has(type)
      ? [...ANY_RECORD, ...own, "activity."]
      : [...ANY_RECORD, ...own];
  }
  return BY_KIND[e.kind] ?? BY_MODULE[module] ?? null;
}

/** The reads a change you made through `action` can affect; null for all of them. */
export function affectedByChange(action: string): Rule | null {
  const module = moduleOf(action);
  // Trashing a record (any type) shows in that type's lists, which the name doesn't tell; nor
  // does an Undo of Pip's, which can put back any of them.
  if (module === "entity" || action === "activity.undo") return null;
  return [`${module}.`, ...(AFTER_CHANGE[module] ?? [])];
}

/** Whether a cached read with this key falls under the rule. */
export function touches(rule: Rule, queryKey: readonly unknown[]): boolean {
  const name = queryKey[0];
  if (typeof name !== "string") return true;
  return rule.some((r) => (r.endsWith(".") ? name.startsWith(r) : name === r));
}

/** Joins rules; any "everything" makes the whole thing everything. */
export function union(rules: (Rule | null)[]): Rule | null {
  const out = new Set<string>();
  for (const r of rules) {
    if (r === null) return null;
    for (const x of r) out.add(x);
  }
  return [...out];
}
