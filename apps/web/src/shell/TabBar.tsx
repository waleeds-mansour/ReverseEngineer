// The phone's bottom bar: Today, Mail, Calendar, Tasks, and More for the rest. Pip isn't a tab: its
// bar sits just over these on every screen (jarvis/PipDock.tsx), and a tab puts its conversation
// away.

import { For, type JSX, Show } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { Badge } from "../components/ui.tsx";
import { jarvis } from "../jarvis/JarvisPane.tsx";
import { type Place, phoneTabs, productOf } from "../lib/apps.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";

/** Each tab is a sub-product's home (lib/apps.ts). */
const TABS = phoneTabs();

/**
 * A tab: its icon over its name. The one you're on is in ink and bold. Five share the screen's
 * width, down to 320 px, so none is wider than its share (min-w-0).
 */
const tab = (active: boolean) =>
  `relative flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 py-1 text-micro ${active ? "font-semibold text-ink" : "text-muted"}`;

/**
 * A tab's icon. On the tab you're on it sits on a pill of its sub-product's colour and takes
 * that colour, so it plainly shows it's the one you're on.
 */
function TabIcon(props: { active: boolean; children: JSX.Element }) {
  return (
    <span
      class={`flex h-8 w-full max-w-14 items-center justify-center rounded-full ${props.active ? "bg-hue/15 text-hue" : ""}`}
    >
      {props.children}
    </span>
  );
}

export function TabBar(props: { waiting: number; onMenu: () => void }) {
  const mail = useAction<{ unread: number; toReply: number }>("mail.counts");
  const current = () => (jarvis.open() ? null : layout.panes()[layout.focused()]?.view);
  // Today shows what's waiting for you; Mail, the replies you owe.
  const count = (p: Place) =>
    p.view === "today" ? props.waiting : p.view === "mail" ? (mail.data?.toReply ?? 0) : 0;
  const counted = (p: Place) =>
    p.view === "today" ? "waiting for you" : p.view === "mail" ? "to reply" : undefined;
  return (
    <nav
      class="flex shrink-0 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)]"
      aria-label="Main"
    >
      <For each={TABS}>
        {(t) => (
          <button
            type="button"
            data-product={productOf(t.view)}
            class={tab(current() === t.view)}
            aria-current={current() === t.view ? "page" : undefined}
            onClick={() => {
              jarvis.toggle(false);
              layout.reset({ view: t.view });
            }}
          >
            <TabIcon active={current() === t.view}>
              <Icon name={t.icon} size={24} />
            </TabIcon>
            {t.label}
            {/* On the icon's corner, and read after the tab's name by a screen reader. The soft
                pill lets what's under it through, so it sits on the bar's own colour and the icon
                doesn't show through the number. */}
            <Show when={count(t)}>
              <span class="absolute top-0.5 left-1/2 ml-2 rounded-pill bg-panel ring-2 ring-panel">
                <Badge tone="accent" count={count(t)} countLabel={counted(t)} />
              </span>
            </Show>
          </button>
        )}
      </For>
      <button type="button" class={tab(false)} onClick={props.onMenu}>
        <TabIcon active={false}>
          <Icon name="menu" size={24} />
        </TabIcon>
        More
      </button>
    </nav>
  );
}
