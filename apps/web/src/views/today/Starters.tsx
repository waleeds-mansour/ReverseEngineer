// What you start most, under Pip's line on Today: planning the day with Pip, a task (with what's
// typed in Pip's bar as its title), an email. Each does what it says once: a tap while it's on its
// way, or a double-click's second click, does nothing more. Asking Pip anything else is its bar at
// the bottom of the screen.

import { createSignal } from "solid-js";
import { Chip, onceEach } from "../../components/Chip.tsx";
import { jarvis } from "../../jarvis/JarvisPane.tsx";
import { takeTyped } from "../../jarvis/PipBar.tsx";
import { askNewTask } from "../../lib/newTask.ts";
import { act, useAction } from "../../lib/query.ts";
import { blankDraft } from "../../lib/today.ts";
import type { MailAccount, MailDraft } from "../../lib/types.ts";
import type { Go } from "./parts.tsx";

type Chore = "plan" | "email";

export function Starters(props: { go: Go; class?: string }) {
  const drafts = useAction<MailDraft[]>("mail.drafts");
  const accounts = useAction<MailAccount[]>("mail.accounts");
  const [busy, setBusy] = createSignal<ReadonlySet<Chore>>(new Set());
  const once = onceEach(busy, setBusy);

  /** A new conversation with Pip about planning the day, shown in Pip's bar. */
  const plan = () =>
    once("plan", async () => {
      const r = await act<{ conversationId: string }>("chat.send", { text: "Plan my day" });
      if (!r) return;
      jarvis.setConversationId(r.conversationId);
      jarvis.toggle(true);
    });

  // A new message is written at the top of Mail; one already started from the same account, and
  // still empty, is used.
  const writeEmail = () =>
    once("email", async () => {
      const from = accounts.data?.[0]?.address;
      if (blankDraft(drafts.data, from) || (await act("mail.draft", { text: "" })))
        props.go({ view: "mail" });
    });

  return (
    // One line, even on a phone: it scrolls sideways rather than taking two.
    <div
      class={`-mx-4 flex items-center gap-2 overflow-x-auto px-4 md:mx-0 md:px-0 ${props.class ?? ""}`}
    >
      <Chip icon="today" busy={busy().has("plan")} onClick={() => void plan()}>
        Plan my day
      </Chip>
      <Chip icon="plus" onClick={() => askNewTask(true, takeTyped())}>
        New task
      </Chip>
      <Chip icon="mail" busy={busy().has("email")} onClick={() => void writeEmail()}>
        Write email
      </Chip>
    </div>
  );
}
