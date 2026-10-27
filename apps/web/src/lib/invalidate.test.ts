import { describe, expect, it } from "vitest";
import { affectedBy, affectedByChange, type Rule, touches, union } from "./invalidate.ts";

const key = (name: string, input: unknown = {}) => [name, input] as const;
const hits = (rule: Rule | null, name: string) => rule === null || touches(rule, key(name));

describe("what a live event refreshes", () => {
  it("refreshes the inbox for inbox changes and nothing else on screen", () => {
    const rule = affectedBy({ kind: "notification.updated", payload: {} });
    expect(hits(rule, "inbox.list")).toBe(true);
    for (const other of ["mail.threads", "task.list", "note.list", "calendar.events"])
      expect(hits(rule, other)).toBe(false);
  });

  it("refreshes every mail read for mail events, and the people they're from", () => {
    const rule = affectedBy({ kind: "mail.changed", payload: {} });
    for (const name of ["mail.threads", "mail.thread", "mail.counts", "mail.search", "mail.drafts"])
      expect(hits(rule, name)).toBe(true);
    expect(hits(rule, "person.view")).toBe(true);
    expect(hits(rule, "inbox.list")).toBe(false);
    expect(hits(rule, "task.list")).toBe(false);
  });

  it("refreshes a record's own lists, plus the views that show any record", () => {
    const rule = affectedBy({ kind: "entity.updated", payload: { type: "task" } });
    for (const name of ["task.list", "task.get", "entity.get", "entity.links", "inbox.list"])
      expect(hits(rule, name)).toBe(true);
    expect(hits(rule, "note.list")).toBe(false);
    expect(hits(rule, "mail.threads")).toBe(false);
    const thread = affectedBy({ kind: "entity.created", payload: { type: "email_thread" } });
    expect(hits(thread, "mail.threads")).toBe(true);
    expect(hits(thread, "task.list")).toBe(false);
  });

  it("refreshes approvals where they show: the inbox, the list and the chat", () => {
    const rule = affectedBy({ kind: "approval.requested", payload: {} });
    for (const name of ["inbox.list", "approval.list", "conversation.get"])
      expect(hits(rule, name)).toBe(true);
  });

  it("refreshes everything for an event or record type it doesn't know", () => {
    expect(affectedBy({ kind: "brand_new.thing", payload: {} })).toBeNull();
    expect(affectedBy({ kind: "entity.updated", payload: { type: "hologram" } })).toBeNull();
    expect(affectedBy({ kind: "entity.restored", payload: {} })).toBeNull();
  });
});

describe("what a change you make refreshes", () => {
  it("refreshes its own module's reads, plus the ones it's known to touch", () => {
    const routine = affectedByChange("routine.update");
    expect(hits(routine, "routine.list")).toBe(true);
    expect(hits(routine, "system.status")).toBe(true);
    expect(hits(routine, "mail.threads")).toBe(false);
    const google = affectedByChange("google.disconnect");
    expect(hits(google, "mail.accounts")).toBe(true);
    expect(hits(google, "calendar.calendars")).toBe(true);
  });

  it("refreshes Coming up after you cancel a reminder there, when Jarvis sets one, and when one rings", () => {
    const cancel = affectedByChange("reminder.cancel");
    expect(hits(cancel, "reminder.list")).toBe(true);
    expect(hits(cancel, "system.status")).toBe(true);
    expect(hits(affectedBy({ kind: "clock.fired" }), "reminder.list")).toBe(true);
    // Jarvis setting or cancelling one shows once its turn ends.
    expect(hits(affectedBy({ kind: "jarvis.turn_finished" }), "reminder.list")).toBe(true);
  });

  it("refreshes What Pip did as a turn works and ends, and as you answer what it asked", () => {
    for (const kind of [
      "conversation.appended",
      "jarvis.turn_finished",
      "approval.requested",
      "approval.resolved",
    ])
      expect(hits(affectedBy({ kind }), "activity.timeline")).toBe(true);
    expect(hits(affectedByChange("jarvis.cancel_turn"), "activity.timeline")).toBe(true);
    // A sync's mail doesn't: the timeline reads itself again now and then for those.
    expect(hits(affectedBy({ kind: "mail.received" }), "activity.timeline")).toBe(false);
  });

  it("refreshes Pip's desk on Today as a turn starts and ends, and after you stop one", () => {
    for (const kind of ["jarvis.turn_started", "jarvis.turn_finished"])
      expect(hits(affectedBy({ kind }), "jarvis.desk")).toBe(true);
    expect(hits(affectedBy({ kind: "jarvis.turn_started" }), "activity.timeline")).toBe(true);
    expect(hits(affectedByChange("jarvis.cancel_turn"), "jarvis.desk")).toBe(true);
  });

  it("refreshes everything after trashing a record, whose type it can't see", () => {
    expect(affectedByChange("entity.trash")).toBeNull();
  });

  it("refreshes every Undo of Pip's where it shows, but not the timeline for mail", () => {
    // Pressing one can put back any record.
    expect(affectedByChange("activity.undo")).toBeNull();
    for (const kind of ["activity.undone", "task.status_changed", "memory.changed"])
      expect(hits(affectedBy({ kind }), "activity.timeline")).toBe(true);
    const task = affectedBy({ kind: "entity.deleted", payload: { type: "task" } });
    for (const name of ["activity.undos", "activity.timeline", "jarvis.did"])
      expect(hits(task, name)).toBe(true);
    expect(hits(affectedBy({ kind: "notification.created" }), "activity.undos")).toBe(true);
    // A conversation Pip trashed comes back by its Undo; an event you moved greys the calendar's.
    const talk = affectedBy({ kind: "entity.deleted", payload: { type: "conversation" } });
    expect(hits(talk, "activity.undos")).toBe(true);
    const moved = affectedBy({ kind: "calendar.event_changed" });
    expect(hits(moved, "activity.undos")).toBe(true);
    expect(hits(moved, "activity.timeline")).toBe(false);
    const thread = affectedBy({ kind: "entity.created", payload: { type: "email_thread" } });
    expect(hits(thread, "activity.undos")).toBe(false);
    expect(hits(thread, "activity.timeline")).toBe(false);
    // What Pip did to your mail has an Undo on Today, which a later change greys; a draft Pip
    // threw away comes back by its Undo.
    const mail = affectedBy({ kind: "mail.changed", payload: {} });
    expect(hits(mail, "activity.undos")).toBe(true);
    expect(hits(mail, "mail.threads")).toBe(true);
    expect(hits(mail, "activity.timeline")).toBe(false);
    expect(hits(affectedBy({ kind: "mail.received", payload: {} }), "activity.undos")).toBe(false);
    const draft = affectedBy({ kind: "entity.deleted", payload: { type: "email_draft" } });
    for (const name of ["activity.undos", "activity.timeline", "mail.drafts"])
      expect(hits(draft, name)).toBe(true);
  });
});

describe("rules", () => {
  it("match a module by prefix and an action by name", () => {
    expect(touches(["mail."], key("mail.thread"))).toBe(true);
    expect(touches(["mail."], key("mailbox.list"))).toBe(false);
    expect(touches(["inbox.list"], key("inbox.list", { view: "done" }))).toBe(true);
    expect(touches(["inbox.list"], key("inbox.listing"))).toBe(false);
  });

  it("join, and anything joined with everything is everything", () => {
    expect(union([["a."], ["b.c", "a."]])).toEqual(["a.", "b.c"]);
    expect(union([["a."], null])).toBeNull();
  });
});
