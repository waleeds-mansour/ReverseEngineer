// Pip, docked at the bottom of the window: its bar, floating over the bottom of every page, and
// over the page when you use it, your conversation with it, grown up out of the bar. Esc, its x or
// a click outside puts it away again, back to the bar, and you're back where you were; the
// conversation stays for next time. The page shows through around the bar, with no strip of its
// own: each pane keeps the bar's height clear, or scrolls its last row up past it (index.css,
// from onHeight). On a phone the conversation takes the page's place above the tab bar instead
// (App.tsx), and the bar sits over the tabs.

import { onCleanup, Show } from "solid-js";
import { narrow } from "../lib/narrow.ts";
import { JarvisPane, jarvis } from "./JarvisPane.tsx";
import { PipBar } from "./PipBar.tsx";

const putAway = () => jarvis.toggle(false);

export function PipDock(props: { onHeight: (px: number) => void }) {
  /** Tells the shell how much of the page's bottom the bar covers, and nothing once it's gone. */
  const measure = (el: HTMLDivElement) => {
    const seen = new ResizeObserver(() => props.onHeight(el.offsetHeight));
    seen.observe(el);
    onCleanup(() => {
      seen.disconnect();
      props.onHeight(0);
    });
  };
  return (
    <>
      {/* Out of reach while the conversation is open over it, so Tab doesn't land in it. Only the
          bar takes clicks: beside it, they reach the page. */}
      <Show when={!(narrow() && jarvis.open())}>
        <div
          ref={measure}
          class="pointer-events-none absolute inset-x-0 bottom-0 z-(--z-bar) px-3 pt-1 pb-2.5 md:px-6 md:pb-3"
          inert={jarvis.open()}
        >
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
