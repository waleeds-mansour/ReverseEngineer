// Mail's bundles as the page shows them: each one's name, icon and what's in it, and the "Move to"
// items a conversation's menus offer. A move stays: sync never sorts that conversation again until
// "Sort automatically" lets the rules have it back. The toast's Undo puts it back as it was, moved
// by hand or not.

import type { IconName } from "../../components/icons.tsx";
import type { MenuItem } from "../../components/Menu.tsx";
import { toast } from "../../lib/live.ts";
import { act } from "../../lib/query.ts";
import type { MailBundle } from "../../lib/types.ts";

/** In the order the inbox shows them: People on top. */
export const BUNDLES: readonly MailBundle[] = ["people", "updates", "receipts", "newsletters"];

export const BUNDLE_LOOK: Record<MailBundle, { name: string; icon: IconName; what: string }> = {
  people: { name: "People", icon: "people", what: "conversations with people" },
  updates: { name: "Updates", icon: "bell", what: "notifications, shipping and accounts" },
  receipts: { name: "Receipts", icon: "file-text", what: "orders, invoices and payments" },
  newsletters: { name: "Newsletters", icon: "text-quote", what: "lists and marketing" },
};

/** Where a conversation is, and whether it was moved there by hand. */
interface Place {
  bundle: MailBundle;
  moved: boolean;
}

/** As mail.set_bundle answers: where it is now, and where it was. */
type Moved = Place & { previous: Place };

/** Moves a conversation to a bundle, or back to the rules ("auto"), with an Undo. */
export async function moveTo(id: string, to: MailBundle | "auto") {
  const input = to === "auto" ? { threadId: id, auto: true } : { threadId: id, bundle: to };
  const r = await act<Moved>("mail.set_bundle", input);
  if (!r) return;
  const was = r.previous;
  toast.show(
    to === "auto"
      ? `Sorted automatically: in ${BUNDLE_LOOK[r.bundle].name}.`
      : `Moved to ${BUNDLE_LOOK[r.bundle].name}.`,
    "info",
    {
      label: "Undo",
      run: () =>
        void act(
          "mail.set_bundle",
          was.moved ? { threadId: id, bundle: was.bundle } : { threadId: id, auto: true },
        ),
    },
  );
}

/** "Move to Updates" and the rest, and "Sort automatically" for one moved by hand. */
export const moveItems = (t: { id: string; bundle: MailBundle; bundleMoved: boolean }) => {
  const items: MenuItem[] = BUNDLES.filter((b) => b !== t.bundle).map((b) => ({
    label: `Move to ${BUNDLE_LOOK[b].name}`,
    icon: BUNDLE_LOOK[b].icon,
    run: () => void moveTo(t.id, b),
  }));
  if (t.bundleMoved)
    items.push({
      label: "Sort automatically",
      icon: "rotate-cw",
      run: () => void moveTo(t.id, "auto"),
    });
  return items;
};
