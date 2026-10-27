// Mail's keys (Mail.tsx). j/k go through the conversations and on into the bundle rows under them;
// Enter or o opens either. e archive, r reply, t make a task, s star, u read or unread, n sends the
// sender to Noise (out of People) or back to Signal, d no reply needed, # trash, c write, and Esc
// goes back from an open bundle to the inbox.

import { type Binding, listKeys } from "../../lib/hotkeys.ts";
import { makeTask } from "../../lib/mailActions.ts";
import type { BundledThread, MailBundle } from "../../lib/types.ts";

export interface MailKeys {
  focused: () => boolean;
  /** Conversations listed and bundle rows after them; where the keyboard is among them. */
  count: () => number;
  index: () => number;
  setIndex: (i: number) => void;
  /** The conversation the keyboard is on, or the bundle row. */
  current: () => BundledThread | undefined;
  onBundle: () => MailBundle | undefined;
  /** A bundle is open, and Esc closes it. */
  bundleOpen: () => boolean;
  openBundle: (b: MailBundle | null) => void;
  open: (t: BundledThread | undefined) => void;
  archive: (t: BundledThread | undefined) => void;
  reply: (t: BundledThread | undefined) => void;
  compose: () => void;
  /** Runs an action, and says `done` once it has. */
  run: (name: string, input: Record<string, unknown>, done?: string) => Promise<void>;
}

export function mailKeys(o: MailKeys): Binding[] {
  const when = o.focused;
  const on = (f: (t: BundledThread) => void) => () => {
    const t = o.current();
    if (t) f(t);
  };
  const openHere = () => {
    const b = o.onBundle();
    if (b) o.openBundle(b);
    else o.open(o.current());
  };
  // Noise keeps the sender out of People: the conversation leaves it at once (bundles.ts).
  const otherLane = (t: BundledThread) => {
    const from = t.participants.find((p) => p.address !== t.account);
    if (!from) return;
    const to = t.lane === "noise" ? "signal" : "noise";
    void o.run(
      "mail.set_lane",
      { sender: from.address, lane: to },
      to === "noise"
        ? `Mail from ${from.address} goes to Noise now, out of People.`
        : `Mail from ${from.address} goes to Signal now.`,
    );
  };
  return [
    ...listKeys({ count: o.count, index: o.index, setIndex: o.setIndex, when }),
    { keys: "enter", run: openHere, when, label: "Open" },
    { keys: "o", run: openHere, when },
    { keys: "e", run: () => o.archive(o.current()), when, label: "Archive" },
    { keys: "r", run: () => o.reply(o.current()), when, label: "Reply" },
    { keys: "t", run: on((t) => void makeTask(t)), when, label: "Make task" },
    {
      keys: "s",
      run: on((t) => void o.run("mail.star", { ids: [t.id], starred: !t.starred })),
      when,
      label: "Star",
    },
    {
      keys: "u",
      run: on((t) => void o.run("mail.mark_read", { ids: [t.id], read: t.unread })),
      when,
      label: "Read or unread",
    },
    { keys: "n", run: on(otherLane), when, label: "Sender to Noise or Signal" },
    {
      keys: "d",
      run: on((t) => {
        if (t.waiting) void o.run("mail.no_reply", { ids: [t.id] }, "Marked as needing no reply.");
      }),
      when,
      label: "No reply needed",
    },
    { keys: "c", run: o.compose, when, label: "Write an email" },
    {
      keys: "#",
      run: on((t) => void o.run("mail.trash", { ids: [t.id] }, "Moved to the trash.")),
      when,
      label: "Trash",
    },
    {
      keys: "escape",
      run: () => o.openBundle(null),
      when: () => o.focused() && o.bundleOpen(),
      label: "Back to the inbox",
    },
  ];
}
