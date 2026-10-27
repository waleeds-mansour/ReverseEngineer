// Pip, docked at the bottom of the window: its bar, under every page, and over the page when you
// use it, your conversation with it, grown up out of the bar. Esc, its x or a click outside puts it
// away again, back to the bar, and you're back where you were; the conversation stays for next
// time. The bar has a row of its own, so it never covers a page's last row. On a phone the
// conversation takes the page's place above the tab bar instead (App.tsx), and the bar sits over
// the tabs.

import { Show } from "solid-js";
import { narrow } from "../lib/narrow.ts";
import { JarvisPane, jarvis } from "./JarvisPane.tsx";
import { PipBar } from "./PipBar.tsx";

const putAway = () => jarvis.toggle(false);

export function PipDock() {
  return (
    <>
      {/* Out of reach while the conversation is open over it, so Tab doesn't land in it. */}
      <Show when={!(narrow() && jarvis.open())}>
        <div class="shrink-0 px-3 pt-1 pb-2.5 md:px-6 md:pb-3" inert={jarvis.open()}>
          <PipBar />
        </div>
      </Show>
      <Show when={jarvis.open() && !narrow()}>
        <div class="fixed inset-0 z-(--z-bar) bg-black/20" onClick={putAway} />
        <div class="fixed bottom-3 left-1/2 z-(--z-bar) flex h-[min(37.5rem,calc(100dvh-6rem))] w-[min(47.5rem,calc(100vw-2rem))] -translate-x-1/2 animate-enter overflow-hidden rounded-sheet border border-line shadow-4">
          <JarvisPane onClose={putAway} />
        </div>
      </Show>
    </>
  );
}
