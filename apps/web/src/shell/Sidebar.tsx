// The phone's menu (More on its tab bar): Hearth's seven places (Today and six sub-products), where
// you are, what's waiting on you, and whether the live connection is up. Hearth's own menu is at
// the top (Trash, the desktop app, signing out); Settings sits at the bottom. On a
// computer the same places are the tabs along the top (TopBar.tsx), which share its pieces here.

import { For, type JSX } from "solid-js";
import { Icon } from "../components/icons.tsx";
import { NookMark } from "../components/Mark.tsx";
import { type MenuItem, Overflow } from "../components/Menu.tsx";
import { Badge, Kbd } from "../components/ui.tsx";
import { JarvisStatusMark, jarvis } from "../jarvis/JarvisPane.tsx";
import { authPost } from "../lib/api.ts";
import { APPS, type App, type AppId, appOf } from "../lib/apps.ts";
import { okToSignOut } from "../lib/docStore.ts";
import { live } from "../lib/live.ts";
import { layout } from "../lib/panes.ts";
import { useAction } from "../lib/query.ts";
import type { ListView } from "../lib/routes.ts";
import { openSettings } from "../lib/settingsNav.ts";
import { useWaiting } from "../lib/waiting.ts";

/** What a place's count is of, said after the number to a screen reader. */
export const COUNTED: Partial<Record<AppId, string>> = {
  today: "waiting for you",
  mail: "to reply",
};

/** Whether the live connection is up, in a word. */
const liveWord = () => (live.connected() ? "Live" : "Reconnecting…");

/** Whether the live connection is up, as a dot: its colour, and its title for a pointer. */
export function LiveDot(props: { class?: string }) {
  return (
    <span
      aria-hidden="true"
      class={`size-1.5 rounded-full ${live.connected() ? "bg-ok" : "bg-faint"} ${props.class ?? ""}`}
      title={liveWord()}
    />
  );
}

/**
 * The dot's word for a screen reader, so its colour isn't the only sign. It goes beside the dot,
 * never inside a button with a name of its own, which a screen reader says in its place.
 */
export const LiveWord = () => <span class="sr-only">{liveWord()}</span>;

/** What Today shows needing you, for its badge on the tabs and the phone's tab bar. */
export { useWaiting } from "../lib/waiting.ts";

/** Hearth's own menu: the desktop app and signing out, and the trash where it has no tab. */
export function nookMenu(opts: {
  onSignOut: () => void;
  /** The trash is in the top's More on a computer, so only the phone's menu lists it here. */
  trash?: () => void;
  /** Called once something's picked (the phone's menu closes). */
  onPicked?: (() => void) | undefined;
}): MenuItem[] {
  const signOut = async () => {
    // Signing out deletes this device's copies, edits Hearth hasn't got included.
    if (!(await okToSignOut())) return;
    await authPost("logout").catch(() => {});
    opts.onSignOut();
  };
  return [
    ...(opts.trash ? [{ label: "Trash", icon: "trash-2" as const, run: opts.trash }] : []),
    {
      label: "Desktop app",
      icon: "monitor",
      run: () => {
        openSettings("desktop");
        opts.onPicked?.();
      },
    },
    { label: "Sign out", icon: "log-out", run: () => void signOut() },
  ];
}

export function Sidebar(props: {
  onPalette: () => void;
  onSignOut: () => void;
  /** The menu is a drawer that closes once you pick something. */
  onPicked: () => void;
}) {
  const waiting = useWaiting();
  const mail = useAction<{ unread: number; toReply: number }>("mail.counts");
  const current = () => {
    const view = layout.panes()[layout.focused()]?.view;
    return view ? appOf(view).id : undefined;
  };

  // Today counts what it shows needing you (approvals, drafts ready to send); Mail, replies you owe.
  const count = (id: AppId) => {
    if (id === "today") return waiting();
    if (id === "mail") return mail.data?.toReply ?? 0;
    return 0;
  };

  /** Opens a place at its home, in place of what's there, and the menu closes. */
  const open = (view: ListView) => {
    jarvis.toggle(false);
    layout.reset({ view });
    props.onPicked();
  };

  const row = (app: App): JSX.Element => (
    <button
      type="button"
      // Its icon takes its sub-product's colour while it's the place you're in.
      data-product={app.hue ? app.id : undefined}
      class={`group flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm ${current() === app.id ? "bg-panel font-medium shadow-1" : "text-muted hover:text-ink"}`}
      aria-current={current() === app.id ? "page" : undefined}
      onClick={() => open(app.views[0]!)}
    >
      {app.icon === "mark" ? (
        <JarvisStatusMark />
      ) : (
        <Icon
          name={app.icon}
          class={current() === app.id ? "text-hue" : "text-faint group-hover:text-muted"}
        />
      )}
      <span class="flex-1">{app.label}</span>
      <Badge tone="accent" count={count(app.id)} countLabel={COUNTED[app.id]} />
    </button>
  );

  return (
    <nav
      aria-label="Places"
      class="flex h-full w-52 shrink-0 flex-col border-r border-line bg-sunk/50 px-2 py-3"
    >
      <div class="mb-3 flex min-h-7 items-center gap-1 pl-0.5">
        <Overflow
          label="Nook menu"
          start
          class="flex min-h-11 min-w-0 items-center gap-2 rounded-md px-1.5 hover:bg-panel"
          items={nookMenu({
            onSignOut: props.onSignOut,
            trash: () => open("trash"),
            onPicked: props.onPicked,
          })}
        >
          <NookMark size={20} />
          <span class="font-semibold">Nook</span>
          <LiveDot />
          <Icon name="chevron-down" size={14} class="text-faint" />
        </Overflow>
        <LiveWord />
      </div>
      <button
        type="button"
        class="mb-3 flex items-center gap-2 rounded-md border border-line bg-panel px-2 py-1.5 text-left text-sm text-muted"
        onClick={props.onPalette}
      >
        <Icon name="search" />
        <span class="min-w-0 flex-1 truncate">Search…</span>
        <span class="hidden shrink-0 md:inline">
          <Kbd keys="mod+k" />
        </span>
      </button>
      <ul class="min-h-0 space-y-0.5 overflow-y-auto">
        <For each={APPS.filter((a) => !a.utility)}>{(app) => <li>{row(app)}</li>}</For>
      </ul>
      <div class="flex-1" />
      <For each={APPS.filter((a) => a.utility)}>{(app) => <div class="mb-1">{row(app)}</div>}</For>
    </nav>
  );
}
