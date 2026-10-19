// The panel's two ways to Nook: the nook_ui command, and the 'nook://state' event nook-wm sends
// whenever something changes. A state can arrive late, after a newer one; seq says which is newer
// within one run of the observer, and a state from a new run (or from Nook stopping) always wins.

import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { commands, type NookState, type UiCmd, type UiReply } from "@/bindings";

export const STATE_EVENT = "nook://state";

export async function ask(cmd: UiCmd): Promise<UiReply> {
  const reply = await commands.nookUi(cmd);
  if (reply.status === "error") {
    throw new Error(reply.error);
  }
  return reply.data;
}

export { newer } from "./link";

export function onState(
  handler: (state: NookState) => void,
): Promise<UnlistenFn> {
  // The panel's own window only: a global listen() would also hear the short state sent to the
  // bar and the popover.
  return getCurrentWebviewWindow().listen<NookState>(STATE_EVENT, (event) =>
    handler(event.payload),
  );
}
