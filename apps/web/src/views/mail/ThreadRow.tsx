// One conversation in Mail's list: who it's with, its subject and first words, and its marks
// (starred, a draft waiting, a reply owed). Pointing at it on a computer shows Archive, Make task
// and Reply; its menu, there on a phone too, moves it to another bundle.

import { Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { IconButton } from "../../components/kit/IconButton.tsx";
import { Overflow, ROW_MENU } from "../../components/Menu.tsx";
import { Badge } from "../../components/ui.tsx";
import { ago } from "../../lib/format.ts";
import type { BundledThread, MailAddress, MailDraft } from "../../lib/types.ts";
import { moveItems } from "./bundleLook.ts";

export const named = (a: MailAddress | undefined) => a?.name || a?.address || "someone";

export function ThreadRow(props: {
  t: BundledThread;
  /** The row the keyboard is on. */
  active: boolean;
  /** Listed outside the inbox (starred, all mail...), where being in the inbox is a mark. */
  outside: boolean;
  /** Mail's To reply or Waiting, which say less about what they're all for. */
  lane: string;
  /** Who wrote the reply waiting to go in it, if one is. */
  drafted?: MailDraft["by"];
  onOpen: (beside: boolean) => void;
  onArchive: () => void;
  onTask: () => void;
  onReply: () => void;
}) {
  const t = () => props.t;
  return (
    <li
      class="group cursor-pointer border-b border-line px-4 py-2.5"
      data-active={props.active}
      onClick={(e) => props.onOpen(e.shiftKey)}
    >
      <div class="flex items-baseline gap-3">
        <span
          class={`mt-1.5 size-2 shrink-0 self-start rounded-full ${t().unread ? "bg-accent" : "bg-transparent"}`}
        />
        {/* Narrower on a phone, where the subject needs the room. */}
        <span class={`w-24 shrink-0 truncate text-sm md:w-40 ${t().unread ? "font-semibold" : ""}`}>
          {t()
            .participants.filter((p) => p.address !== t().account)
            .map(named)
            .join(", ") || "me"}
          <Show when={t().messageCount > 1}>
            <span class="text-faint"> {t().messageCount}</span>
          </Show>
        </span>
        <span class="min-w-0 flex-1 truncate text-sm">
          <span class={t().unread ? "font-semibold" : ""}>{t().subject}</span>
          <span class="text-muted"> · {t().snippet}</span>
        </span>
        <Show when={t().starred}>
          <span class="self-center text-warn" title="Starred">
            <Icon name="star" size={14} filled label="Starred" />
          </span>
        </Show>
        <Show when={props.outside && t().inInbox}>
          <Badge>inbox</Badge>
        </Show>
        <Show when={props.drafted}>
          {(by) => (
            <Badge icon="reply" class="self-center">
              {by() === "jarvis" ? "Pip drafted" : "Draft"}
            </Badge>
          )}
        </Show>
        <Show when={t().waiting === "you" && props.lane !== "reply"}>
          <Badge>reply</Badge>
        </Show>
        <Show when={t().waiting === "them" && props.lane === "waiting"}>
          <Badge>no answer yet</Badge>
        </Show>
        <span class="shrink-0 text-xs text-faint md:group-hover:hidden">
          {ago(t().lastMessageAt)}
        </span>
        {/* Pointing at a row on a computer; a phone has the open email's bar. */}
        <span
          class="-my-1.5 hidden shrink-0 self-center md:group-hover:flex"
          onClick={(e) => e.stopPropagation()}
        >
          <IconButton
            icon="archive"
            label={t().inInbox ? "Archive" : "Move to inbox"}
            title={t().inInbox ? "Archive (e)" : "Move to inbox (e)"}
            onClick={() => props.onArchive()}
          />
          <IconButton
            icon="tasks"
            label="Make task"
            title="Make task (t)"
            onClick={() => props.onTask()}
          />
          <IconButton
            icon="reply"
            label="Reply"
            title="Reply (r)"
            onClick={() => props.onReply()}
          />
        </span>
        <span class="-my-1.5 self-center">
          <Overflow
            class={ROW_MENU}
            label={`Move ${t().subject || "this conversation"} to another bundle`}
            items={moveItems(t())}
          />
        </span>
      </div>
    </li>
  );
}
