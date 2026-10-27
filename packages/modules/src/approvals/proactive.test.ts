// What Pip does on its own and what waits for your yes (the owner, 2026-10-27): everything that
// stays in your own world it just does, even in work it started itself after reading an email;
// anything that reaches other people asks, and so does changing code. Pinned per action, on the
// real registry, so a change to an action's risk shows up here.
import {
  type ActionDef,
  asksPip,
  BACKGROUND_READ_ONLY,
  type Caller,
  decide,
  defineAction,
  type Hold,
  isHeldReason,
  isVisibleTo,
  jarvisCaller,
  roleHold,
  systemCaller,
} from "@hearth/kernel";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ALL_MODULES } from "../index.ts";

type Want = "act" | "ask" | "held" | "never";

const ACTIONS = new Map<string, ActionDef>(
  ALL_MODULES.flatMap((m) => m.actions.map((a) => [a.name, a] as const)),
);

/** Work Pip started itself because an email came in: the hardest case for acting unasked. */
const fromMail = jarvisCaller("untrusted", { mode: "proactive" });
/** You asked Pip in chat, and nothing outside was read. */
const yourAsk = jarvisCaller("owner");

function verdict(def: ActionDef, caller: Caller, rule = false, holds: Hold[] = []): Want {
  if (!isVisibleTo(def, "agent")) return "never";
  const d = decide(def, caller, rule, holds);
  if (d.kind === "allow") return "act";
  if (d.kind === "ask") return "ask";
  return isHeldReason(d.reason) ? "held" : "never";
}

const action = (name: string): ActionDef => {
  const def = ACTIONS.get(name);
  if (!def) throw new Error(`No action ${name}: the table names one that's gone`);
  return def;
};

/** Each category of the policy, the actions in it, and what Pip does after reading an email. */
const POLICY: [string, string[], Want][] = [
  ["tasks: create, update, complete", ["task.create", "task.update"], "act"],
  [
    "notes, docs, sheets and boards",
    ["note.create", "note.update", "doc.edit", "sheet.create", "sheet.set", "canvas.add"],
    "act",
  ],
  [
    "your own calendar events with no guests: add, move, change, remove",
    [
      "calendar.create_event",
      "calendar.update_event",
      "calendar.delete_event",
      "calendar.move_own_event",
      "calendar.remove_own_event",
      "calendar.block_task",
    ],
    "act",
  ],
  ["reminders", ["reminder.create", "reminder.cancel"], "act"],
  [
    "mail triage: archive, read, star, snooze, lanes, bundles",
    [
      "mail.archive",
      "mail.unarchive",
      "mail.mark_read",
      "mail.star",
      "inbox.snooze",
      "mail.set_lane",
      "mail.set_bundle",
    ],
    "act",
  ],
  ["drafts, saved and never sent", ["mail.draft", "mail.draft_update"], "act"],
  ["people and personas", ["person.create", "person.update", "person.write_persona"], "act"],
  ["the trash, which can be put back", ["entity.trash", "mail.trash", "entity.restore"], "act"],
  ["invitations from people you know when you're free (D71)", ["calendar.accept_invite"], "act"],
  ["telling you", ["inbox.notify", "jarvis.observe"], "act"],
  ["sending, replying to or forwarding email", ["mail.send"], "ask"],
  ["Slack messages to other people", ["slack.dm", "slack.post_in_channel"], "ask"],
  [
    "calendar changes guests see",
    [
      "calendar.schedule_meeting",
      "calendar.update_meeting",
      "calendar.cancel_meeting",
      "calendar.respond",
    ],
    "ask",
  ],
  ["sending, booking or buying on a web page", ["browser.submit"], "ask"],
  ["changing an outside database", ["data.change"], "ask"],
  // Not contact, but what outside words could turn into yours: whose an address is (where mail
  // to "them" goes), and meeting notes that go into your prep as your own words.
  ["who an address belongs to", ["person.add_email"], "ask"],
  ["meeting notes in your voice", ["meeting.start", "meeting.update"], "ask"],
  ["credentials", ["vault.save", "github.connect", "slack.connect"], "never"],
];

describe("Pip on its own, after reading an email", () => {
  for (const [category, names, want] of POLICY)
    it(`${want === "act" ? "does" : want === "ask" ? "asks about" : "never does"} ${category}`, () => {
      for (const name of names)
        expect([name, verdict(action(name), fromMail)]).toEqual([name, want]);
    });

  it("never contacts anyone unasked: no outward action of any module acts on its own", () => {
    const loose = [...ACTIONS.values()]
      .filter((def) => def.risk === "outward" && verdict(def, fromMail) === "act")
      .map((d) => d.name);
    expect(loose).toEqual([]);
  });

  it("turns Notion and Slack asks into tasks: Nook's own job for Notion, Pip's task.create for Slack", () => {
    expect(decide(action("notion.make_task"), systemCaller(), false).kind).toBe("allow");
    expect(verdict(action("task.create"), fromMail)).toBe("act");
  });

  it("says in each tool's description which ones wait for your yes", () => {
    expect(asksPip(action("mail.send"))).toBe(true);
    expect(asksPip(action("calendar.update_meeting"))).toBe(true);
    expect(asksPip(action("entity.trash"))).toBe(false);
    expect(asksPip(action("calendar.update_event"))).toBe(false);
  });
});

/** What asks only once outside words are in play: with nothing outside read, Pip just does it. */
const AFTER_OUTSIDE = new Set(["person.add_email", "meeting.start", "meeting.update"]);

describe("Pip on what you asked it", () => {
  it("does your own things, and still asks before contacting anyone", () => {
    for (const [, names, want] of POLICY)
      for (const name of names) {
        const expected = AFTER_OUTSIDE.has(name) ? "act" : want;
        expect([name, verdict(action(name), yourAsk)]).toEqual([name, expected]);
      }
  });

  it("sends email only with your yes, even with proactive work on", () => {
    expect(verdict(action("mail.send"), yourAsk)).toBe("ask");
    expect(verdict(action("mail.send"), fromMail)).toBe("ask");
  });

  it("lets your Always allow win where you started it, but never after outside content (D70)", () => {
    const post = action("slack.post_in_channel");
    expect(verdict(post, yourAsk, true)).toBe("act");
    expect(verdict(post, fromMail, true)).toBe("ask");
  });
});

describe("code", () => {
  const read = defineAction({
    name: "code.log",
    description: "git log of a repo",
    input: z.object({}),
    risk: "read",
    handler: async () => [],
  });
  const write = defineAction({
    name: "code.start",
    description: "Work a task in a worktree",
    input: z.object({}),
    risk: "internal",
    changesCode: true,
    handler: async () => ({}),
  });

  it("reads and searches code on its own", () => {
    expect(verdict(read, fromMail)).toBe("act");
    expect(verdict(read, yourAsk)).toBe("act");
  });

  it("asks before changing code, even when you asked for it in chat", () => {
    expect(verdict(write, fromMail)).toBe("ask");
    expect(verdict(write, yourAsk)).toBe("ask");
    expect(asksPip(write)).toBe(true);
    // Your Always allow for it wins, as anywhere, where you started it.
    expect(verdict(write, yourAsk, true)).toBe("act");
  });
});

describe("the switch: Pip acts on its own, or its background work only reads", () => {
  it("off, holds what it would have done for your brief instead of doing or asking", () => {
    const off = [BACKGROUND_READ_ONLY];
    expect(verdict(action("calendar.update_event"), fromMail, false, off)).toBe("held");
    expect(verdict(action("entity.trash"), fromMail, false, off)).toBe("held");
    expect(verdict(action("mail.send"), fromMail, false, off)).toBe("held");
    // Notes, tasks and drafts in Nook are still its to keep.
    expect(verdict(action("task.create"), fromMail, false, off)).toBe("act");
    expect(verdict(action("mail.draft"), fromMail, false, off)).toBe("act");
  });

  it("keeps a job's ceiling: a job that only changes Nook doesn't trash", () => {
    const job = [roleHold("Inbox", "internal")];
    expect(verdict(action("entity.trash"), fromMail, false, job)).toBe("held");
    expect(verdict(action("calendar.delete_event"), fromMail, false, job)).toBe("held");
    expect(verdict(action("mail.archive"), fromMail, false, job)).toBe("act");
    // One that may change your own accounts may also put things in the trash: it comes back.
    const accounts = [roleHold("Inbox", "self_external")];
    expect(verdict(action("mail.trash"), fromMail, false, accounts)).toBe("act");
    expect(verdict(action("mail.send"), fromMail, false, accounts)).toBe("held");
  });
});
