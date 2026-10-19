// Which way in a sign-in page offers (D69). A passkey works only at the address it was made at:
// Hearth's own, or the desktop app's window on this PC (http://localhost:<port>) with a Windows
// Hello passkey of its own. Anywhere else no passkey can work, so it never offers one. The
// window can also ask the app to sign it in with this PC's Windows Hello key (D80): "native".

export type WayIn = "setup" | "passkey" | "native" | "hello" | "browser";

export function wayIn(
  page: { origin: string; hostname: string },
  me: { needsSetup: boolean; origin?: string; localPasskey?: boolean; windowHello?: boolean },
  /** In the desktop app's window (lib/desktop.ts). */
  app: boolean,
): WayIn {
  // An older Hearth doesn't say where: as before, here.
  const own = !me.origin || page.origin === me.origin;
  // The setup code makes a passkey for Hearth's own address, so it's entered only there.
  if (me.needsSetup) return own ? "setup" : "browser";
  if (own) return "passkey";
  // Only in the app's window: Chrome or Edge here shares Windows Hello's passkeys, but signing in
  // there would sign the window out. The app's own Windows Hello comes first: no password
  // manager can step in front of it.
  const inWindow = app && page.hostname === "localhost";
  if (inWindow && me.windowHello) return "native";
  if (inWindow && me.localPasskey) return "hello";
  return "browser";
}

/** The window's own passkey can be made here: in the app, at this PC's address by name. */
export const windowPasskeyHere = (
  page: { origin: string; hostname: string },
  origin: string,
  app: boolean,
) => app && page.origin !== origin && page.hostname === "localhost";

/** Where "Connect in your browser" goes: Settings, at Desktop app, at Hearth's own address. */
export const connectLink = (origin: string) => `${origin}/settings?connect=desktop`;
