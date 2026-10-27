// The top of the window on a computer: Nook's menu, a tab for each sub-product's home with what's
// waiting there, More for the rest, then search (Cmd+K) and Settings. Pip isn't a tab: it's the bar
// at the bottom of every screen, so the pages below get the window's whole width. A tab opens in
// the pane you're in, or beside it with shift; the tab of the pane you're in is marked. On a
// narrow window the tabs scroll sideways rather than wrap.

import { For } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { NookMark } from "../components/Mark.tsx";
import { Overflow } from "../components/Menu.tsx";
import { Badge, Button, IconButton, Kbd } from "../components/ui.tsx";
import { type App, type AppId, appOf, MORE, placeOf, topTabs } from "../lib/apps.ts";
import { keyLabel } from "../lib/keys.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import { COUNTED, LiveDot, LiveWord, nookMenu, useWaiting } from "./Sidebar.tsx";

const TABS = topTabs();

const PILL =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill px-3.5 text-sm whitespace-nowrap";
const ON = "bg-sunk font-semibold text-ink";
const OFF = "text-muted hover:bg-sunk/60 hover:text-ink";

export function TopBar(props: { onPalette: () => void; onSignOut: () => void }) {
  const waiting = useWaiting();
  const mail = useAction<{ unread: number; toReply: number }>("mail.counts");
  const view = () => layout.panes()[layout.focused()]?.view;
  const current = (): AppId | undefined => {
    const v = view();
    return v ? appOf(v).id : undefined;
  };
  // Updates is Today's, but it's reached from More, so More is where you are.
  const on = (app: App) => current() === app.id && view() !== "inbox";
  const inMore = () => !!view() && !TABS.some(on) && current() !== "settings";
  const count = (id: AppId) =>
    id === "today" ? waiting() : id === "mail" ? (mail.data?.toReply ?? 0) : 0;

  return (
    <header class="glass flex h-14 shrink-0 items-center gap-2 px-3">
      <Overflow
        label="Nook menu"
        start
        class="flex min-h-9 shrink-0 items-center gap-2 rounded-md px-1.5 hover:bg-sunk/60"
        items={nookMenu({ onSignOut: props.onSignOut })}
      >
        <NookMark size={24} />
        <LiveDot />
      </Overflow>
      <LiveWord />
      <nav
        aria-label="Places"
        class="flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
      >
        <For each={TABS}>
          {(app) => (
            <button
              type="button"
              data-product={app.hue ? app.id : undefined}
              class={`${PILL} ${on(app) ? ON : OFF}`}
              aria-current={on(app) ? "page" : undefined}
              title={`${app.label} (${keyLabel(placeOf(app.views[0]!).keys)})`}
              onClick={(e) => layout.open({ view: app.views[0]! }, { beside: e.shiftKey })}
            >
              {app.label}
              <Badge tone="accent" count={count(app.id)} countLabel={COUNTED[app.id]} />
            </button>
          )}
        </For>
        <Overflow
          label="More"
          class={`${PILL} pr-2.5 ${inMore() ? ON : OFF}`}
          items={MORE.map((v) => {
            const place = placeOf(v);
            return { label: place.label, icon: place.icon, run: () => layout.open({ view: v }) };
          })}
        >
          More
          <Icon name="chevron-down" size={14} class="text-faint" />
        </Overflow>
      </nav>
      <span class="flex-1" />
      <Button
        icon="search"
        title="Search, run a command, or ask Pip"
        class="shrink-0"
        onClick={props.onPalette}
      >
        <span class="max-lg:sr-only">Search</span>
        <span class="max-lg:hidden">
          <Kbd keys="mod+k" />
        </span>
      </Button>
      <IconButton
        icon="settings"
        label="Settings"
        title={`Settings (${keyLabel("g s")})`}
        onClick={(e) => layout.open({ view: "settings" }, { beside: e.shiftKey })}
      />
    </header>
  );
}
