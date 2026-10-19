// Sign in with a passkey (Windows Hello, Touch ID, your phone). The first time, enter the code
// `hearth setup` printed to add your first passkey, at Hearth's own address. Can't use any of
// yours? "Lost your passkey?" takes the code `hearth setup --recover` prints, there too (D81).
// The desktop app's window on this PC asks the app to sign it in with this PC's Windows Hello key
// once connecting has made one (D80), or uses a Windows Hello passkey of its own, or else signs
// in from your browser (D53, D69): no page shows a passkey button that can't work where it is.

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Button } from "../components/kit/Button.tsx";
import { TextButton } from "../components/kit/TextButton.tsx";
import { authPost } from "../lib/api.ts";
import { inDesktopApp } from "../lib/desktop.ts";
import { forgetStarted } from "../lib/version.ts";
import { connectLink, wayIn } from "../lib/wayIn.ts";

export function Login(props: {
  needsSetup: boolean;
  origin?: string;
  localPasskey?: boolean;
  windowHello?: boolean;
  onSignedIn: () => void;
}) {
  const [code, setCode] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // "Lost your passkey?": the recovery code's form instead of the passkey button (D81).
  const [recovering, setRecovering] = createSignal(false);
  const recover = (on: boolean) => {
    setRecovering(on);
    setCode("");
    setError(null);
  };
  // Windows Hello didn't work in the window: the browser is offered too.
  const [helloFailed, setHelloFailed] = createSignal(false);
  const [sent, setSent] = createSignal(false);
  // The app's Windows Hello is asking (D80): it brings the window back here, or into Today.
  const [asked, setAsked] = createSignal(false);
  const app = inDesktopApp();
  const way = () => wayIn(location, props, app);
  // Signed out, or never in: Hearth isn't checked for a new build until you're in (UpdateNotice),
  // so this page opens from the PC next time, not from what's kept (sw.js).
  onMount(() => void forgetStarted());

  // Back from the app's Windows Hello without signing in: why, from ?hello= (hearth/hello.rs).
  const why = new URLSearchParams(location.search).get("hello");
  onMount(() => {
    if (!why) return;
    history.replaceState(history.state, "", location.pathname);
    setHelloFailed(true);
    setError(
      why === "cancelled"
        ? "Windows Hello was closed. Try again, or connect from your browser."
        : why === "connect"
          ? "This window has to be connected again. In your browser: Settings, Desktop app, Connect Nook on this PC."
          : "Windows Hello didn't sign this window in. Try again, or connect from your browser.",
    );
  });
  let waited: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(waited));
  const askApp = () => {
    setError(null);
    setAsked(true);
    location.href = "hearth://sign-in";
    // An app too old to know the link does nothing: the button comes back.
    waited = setTimeout(() => setAsked(false), 60_000);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      props.onSignedIn();
    } catch (err) {
      const e = err as Error;
      if (way() === "hello") {
        setHelloFailed(true);
        setError(
          e.name === "NotAllowedError"
            ? "Windows Hello was closed, or couldn't open in this window. Try again, or connect from your browser."
            : `Windows Hello didn't work here: ${e.message}`,
        );
        return;
      }
      setError(
        e.name === "NotAllowedError"
          ? "The passkey prompt was closed. Try again."
          : e.name === "SecurityError"
            ? "Your passkey only works at Nook's own address, not this one."
            : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  // With the setup code (your first passkey) or the recovery code (one more, D81).
  const register = (kind: "setupCode" | "recoveryCode") =>
    run(async () => {
      const codes = { [kind]: code() };
      const options = await authPost<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "register/options",
        codes,
      );
      const response = await startRegistration({ optionsJSON: options });
      await authPost("register/verify", {
        response,
        ...codes,
        label: navigator.platform || "Passkey",
      });
    });

  const login = () =>
    run(async () => {
      const options =
        await authPost<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await authPost("login/verify", { response });
    });

  // In the app, Windows opens your browser (at Settings, Desktop app, once Hearth is set up);
  // elsewhere, this page goes to Hearth's address.
  const toBrowser = () => {
    if (!props.origin) return;
    setSent(true);
    location.href = app && !props.needsSetup ? connectLink(props.origin) : props.origin;
  };
  const browserButton = (primary: boolean) => (
    <Button
      size="lg"
      variant={primary ? "primary" : "secondary"}
      class="w-full"
      onClick={toBrowser}
    >
      {!app
        ? "Go to Nook's address"
        : props.needsSetup
          ? "Set up Nook in your browser"
          : "Connect in your browser"}
    </Button>
  );

  return (
    <div class="flex h-full items-center justify-center p-6">
      <div class="w-full max-w-sm space-y-5 rounded-xl border border-line bg-panel p-6 shadow-1">
        <div>
          <h1 class="text-xl font-semibold">Nook</h1>
          <p class="text-sm text-muted">
            {props.needsSetup
              ? "Welcome. Add a passkey to get started."
              : "Your workspace, with Pip."}
          </p>
        </div>
        <Switch>
          <Match when={way() === "setup"}>
            <CodeForm
              label={
                <>
                  Setup code from <code class="font-mono">hearth setup</code>
                </>
              }
              code={code()}
              setCode={setCode}
              busy={busy()}
              onSubmit={() => void register("setupCode")}
            />
          </Match>
          <Match when={way() === "passkey" && recovering()}>
            <div class="space-y-3">
              <p class="text-sm text-muted">
                On the PC Nook runs on, run <code class="font-mono">hearth setup --recover</code>.
                Its code adds a new passkey here and signs you in. Your other passkeys keep working.
              </p>
              <CodeForm
                label={
                  <>
                    Recovery code from <code class="font-mono">hearth setup --recover</code>
                  </>
                }
                code={code()}
                setCode={setCode}
                busy={busy()}
                onSubmit={() => void register("recoveryCode")}
              />
              <TextButton alone onClick={() => recover(false)}>
                Sign in with your passkey instead
              </TextButton>
            </div>
          </Match>
          <Match when={way() === "passkey"}>
            <div class="space-y-3">
              <Button
                size="lg"
                variant="primary"
                class="w-full"
                disabled={busy()}
                onClick={() => void login()}
              >
                Sign in with your passkey
              </Button>
              <TextButton alone onClick={() => recover(true)}>
                Lost your passkey?
              </TextButton>
            </div>
          </Match>
          <Match when={way() === "native"}>
            <div class="space-y-2">
              <Button
                size="lg"
                variant="primary"
                class="w-full"
                disabled={asked()}
                onClick={askApp}
              >
                Sign in with Windows Hello
              </Button>
              <Show when={asked()}>
                <p class="text-sm text-muted">Windows Hello is asking. Look for its prompt.</p>
              </Show>
              <Show when={helloFailed()}>{browserButton(false)}</Show>
            </div>
          </Match>
          <Match when={way() === "hello"}>
            <div class="space-y-2">
              <Button
                size="lg"
                variant="primary"
                class="w-full"
                disabled={busy()}
                onClick={() => void login()}
              >
                Sign in with Windows Hello
              </Button>
              <Show when={helloFailed()}>{browserButton(false)}</Show>
            </div>
          </Match>
          <Match when={way() === "browser"}>
            <div class="space-y-3">
              <p class="text-sm text-muted">
                {props.needsSetup
                  ? app
                    ? `Set up Nook in your browser first, at ${props.origin}, with the code \`hearth setup\` printed. Then connect this window from there: Settings, Desktop app.`
                    : `Nook's address for browsers is ${props.origin}. Set it up there, with the code \`hearth setup\` printed.`
                  : app
                    ? "This window was signed out. Your passkeys work at Nook's own address, so sign it in from your browser: Settings, Desktop app, Connect Nook on this PC. Connecting sets up Windows Hello, so next time this window signs in with it."
                    : `Nook's address for browsers is ${props.origin}. Your passkeys work there, not here.`}
              </p>
              {browserButton(true)}
            </div>
          </Match>
        </Switch>
        <Show when={error()}>
          <p class="text-sm text-bad">{error()}</p>
        </Show>
        <Show when={sent() && app && !props.needsSetup}>
          <p class="text-sm text-muted">
            Your browser opens Nook's Settings. Choose Connect Nook on this PC there.
          </p>
        </Show>
      </div>
    </div>
  );
}

/** A code `hearth setup` printed, and the button that makes a passkey with it. */
function CodeForm(props: {
  label: JSX.Element;
  code: string;
  setCode: (code: string) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  // Focused when it shows, after a click too: autofocus works only once a page.
  let input!: HTMLInputElement;
  onMount(() => input.focus());
  return (
    <form
      class="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        props.onSubmit();
      }}
    >
      <label class="block space-y-1">
        <span class="text-sm">{props.label}</span>
        <input
          ref={input}
          class="w-full rounded-md border border-line bg-panel px-3 py-2 font-mono tracking-widest uppercase focus:border-accent"
          value={props.code}
          onInput={(e) => props.setCode(e.currentTarget.value)}
          autocomplete="one-time-code"
        />
      </label>
      <Button
        size="lg"
        variant="primary"
        type="submit"
        class="w-full"
        disabled={props.busy || props.code.trim().length < 6}
      >
        Create passkey
      </Button>
    </form>
  );
}
