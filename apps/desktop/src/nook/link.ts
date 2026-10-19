// The bar's and popover's way to Nook: the one nook_ui command, and the two events Rust sends,
// 'nook://state' (what Nook sees, without the window list) and 'nook://chrome' (the theme,
// services and Pip). They load nothing from the network; Tauri's IPC is all they talk to. The
// dev-only preview (preview/) hands the same pages a fake Link instead.

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { ChromeView, NookState, UiCmd, UiReply } from "@/bindings";

export const STATE_EVENT = "nook://state";
export const CHROME_EVENT = "nook://chrome";

export interface Link {
  ask(cmd: UiCmd): Promise<UiReply>;
  onState(handler: (state: NookState) => void): void;
  onChrome(handler: (chrome: ChromeView) => void): void;
}

// Each page listens on its own window only. A global listen() hears an event sent to any window,
// so the bar would draw the popover's state and the panel would get the bar's short one.
export const tauriLink: Link = {
  ask: (cmd) => invoke<UiReply>("nook_ui", { cmd }),
  onState: (handler) => {
    void getCurrentWebviewWindow().listen<NookState>(STATE_EVENT, (e) =>
      handler(e.payload),
    );
  },
  onChrome: (handler) => {
    void getCurrentWebviewWindow().listen<ChromeView>(CHROME_EVENT, (e) =>
      handler(e.payload),
    );
  },
};

/** Whether `next` should replace `current`. */
export function newer(current: NookState | null, next: NookState): boolean {
  if (current === null) return true;
  if (next.mode !== current.mode) return true;
  // The observer restarted, so its count started again.
  if (next.seq < current.seq && next.seq <= 1) return true;
  return next.seq >= current.seq;
}

/** Whether a chrome view should replace the one shown: Rust numbers them, and a late one loses. */
export function newerChrome(
  current: ChromeView | null,
  next: ChromeView,
): boolean {
  return current === null || next.seq >= current.seq;
}

/** Calls `then` once the page has put its first frame on screen. */
export function afterFirstFrame(then: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(then));
}
