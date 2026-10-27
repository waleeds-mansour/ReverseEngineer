// Mail's inbox in bundles (mail.bundles). People comes first, each conversation a row of its own
// (Mail.tsx lists them under PeopleHeader); every other bundle is one row under them, with how
// many it holds, how many are unread and who it's mostly from. A row opens its bundle's
// conversations in place, under BundleHeader, whose Inbox button goes back. j/k reach the rows
// after the conversations, and Enter opens one.

import { For, Show } from "solid-js";
import { Icon } from "../../components/icons.tsx";
import { SectionHeader } from "../../components/kit/SectionHeader.tsx";
import { Skeleton } from "../../components/kit/Skeleton.tsx";
import { Badge, Button, TextButton } from "../../components/ui.tsx";
import { ago } from "../../lib/format.ts";
import { keyLabel } from "../../lib/keys.ts";
import type { MailBundle, MailBundleCount } from "../../lib/types.ts";
import { BUNDLE_LOOK, BUNDLES } from "./bundleLook.ts";

/** "from github.com, Vercel, Stripe…": the senders mail.bundles names, the most it names. */
function fromLine(c: MailBundleCount): string {
  if (c.senders.length === 0) return BUNDLE_LOOK[c.bundle].what;
  return `from ${c.senders.join(", ")}${c.senders.length >= 3 ? "…" : ""}`;
}

/** People's heading in the bundled inbox, with a way to all of them when only some show. */
export function PeopleHeader(props: { count: number; shown: number; onAll: () => void }) {
  return (
    <SectionHeader
      class="border-b border-line px-4 pt-2 pb-1.5"
      title={
        <span class="flex items-center gap-2">
          <Icon name={BUNDLE_LOOK.people.icon} class="text-muted" />
          {BUNDLE_LOOK.people.name}
        </span>
      }
      count={props.count}
      more={props.count > props.shown ? { run: props.onAll } : undefined}
    />
  );
}

/** Under People's newest: how many more there are, opening all of them. */
export function MorePeople(props: { more: number; onAll: () => void }) {
  return (
    <Show when={props.more > 0}>
      <div class="border-b border-line px-4 py-2 text-sm">
        <TextButton alone onClick={() => props.onAll()}>
          {`${props.more} more ${props.more === 1 ? "conversation" : "conversations"} with people`}
        </TextButton>
      </div>
    </Show>
  );
}

/** The bundles folded into a row each: every one but People that has anything in the inbox. */
export const folded = (counts: readonly MailBundleCount[]) =>
  counts.filter((c) => c.bundle !== "people" && c.count > 0);

/** A row for each folded bundle; `active` is the one the keyboard is on (j/k go on into them). */
export function BundleRows(props: {
  counts: MailBundleCount[];
  active: number | null;
  onOpen: (b: MailBundle) => void;
}) {
  return (
    <Show when={folded(props.counts).length > 0}>
      <ul aria-label="Bundles">
        <For each={folded(props.counts)}>
          {(c, i) => (
            <li class="border-b border-line" data-active={props.active === i()}>
              <button
                type="button"
                class="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left hover:bg-sunk/60 md:min-h-12"
                onClick={() => props.onOpen(c.bundle)}
              >
                <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-sunk text-muted">
                  <Icon name={BUNDLE_LOOK[c.bundle].icon} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-2 text-sm">
                    <span class={c.unread ? "font-semibold" : "font-medium"}>
                      {BUNDLE_LOOK[c.bundle].name}
                    </span>
                    <span class="text-meta text-muted tabular-nums">{c.count}</span>
                    <Badge count={c.unread} tone="accent" countLabel="unread" />
                  </span>
                  <span class="block truncate text-meta text-muted">{fromLine(c)}</span>
                </span>
                <Show when={c.latest}>
                  {(at) => <span class="shrink-0 text-xs text-faint">{ago(at())}</span>}
                </Show>
                <Icon name="chevron-right" size={14} class="shrink-0 text-faint" />
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

/**
 * Where the rows go while mail.bundles hasn't answered: bars their shape while it's on the way,
 * and if it failed, a quiet line that still opens each bundle.
 */
export function BundlesUnknown(props: {
  loading: boolean;
  failed: boolean;
  onOpen: (b: MailBundle) => void;
}) {
  const others = BUNDLES.filter((b) => b !== "people");
  return (
    <>
      <Show when={props.loading}>
        <Skeleton count={others.length} />
      </Show>
      <Show when={props.failed}>
        <p class="border-b border-line px-4 py-3 text-sm text-muted">
          {"Couldn't count the other bundles. Open "}
          <For each={others}>
            {(b, i) => (
              <>
                {i() === 0 ? "" : i() === others.length - 1 ? " or " : ", "}
                <TextButton onClick={() => props.onOpen(b)}>{BUNDLE_LOOK[b].name}</TextButton>
              </>
            )}
          </For>
          .
        </p>
      </Show>
    </>
  );
}

/** An opened bundle's heading: back to the inbox, its name and how many, and what's in it. */
export function BundleHeader(props: { bundle: MailBundle; count?: number; onBack: () => void }) {
  const look = () => BUNDLE_LOOK[props.bundle];
  return (
    <div class="flex min-h-11 items-center gap-2 border-b border-line py-1 pr-4 pl-2">
      <Button
        size="sm"
        variant="quiet"
        icon="arrow-left"
        title={`Back to the inbox (${keyLabel("escape")})`}
        onClick={() => props.onBack()}
      >
        Inbox
      </Button>
      <Icon name={look().icon} class="shrink-0 text-muted" />
      <h2 class="text-heading">{look().name}</h2>
      <Show when={props.count}>
        {(n) => <span class="text-meta text-muted tabular-nums">{n()}</span>}
      </Show>
      <span class="ml-auto hidden truncate text-meta text-muted sm:block">{look().what}</span>
    </div>
  );
}
