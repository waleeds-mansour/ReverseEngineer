# Hearth for Windows

Hearth as a program on your PC (Hearth's decision D53): it starts with Windows into the tray,
opens Hearth in its own window, shows Windows notifications, and does dictation into any app,
voice commands to Jarvis, and talking to Jarvis out loud. It is a fork of
[Handy](https://github.com/cjpais/Handy) (MIT, by CJ Pais), taken at commit
`ffbc9504cbf004ce4819d2ca872fcea92be0fddf`. Handy's own README is kept as
[README.handy.md](README.handy.md), and its license as [LICENSE](LICENSE).

## What Hearth adds

All of it lives in `src-tauri/src/hearth/`, `src-tauri/src/nook/` and
`src-tauri/crates/nook-restore/` (Nook arranging windows, and putting them back),
`src-tauri/nsis/hooks.nsh`, `scripts/build-guard.ts` and
`src/components/settings/HearthSettings.tsx`, with small hooks into Handy's code (look for
`hearth` in `actions.rs`, `settings.rs`, `lib.rs`, `tray.rs`, `cli.rs` and
`transcription_coordinator.rs`, and `nook` in `main.rs`, `build.rs`, `lib.rs` and `tray.rs`).

- **Hearth's window** (`hearth/window.rs`): Hearth's web app from the address in voice settings
  (`http://localhost:4400` on the PC). Tray left-click, Ctrl+Alt+H, or starting the app again
  opens it; closing it hides it. Links elsewhere open in your browser, downloads go to
  Downloads, and files can be dragged in. When Hearth doesn't answer, a built-in page says so
  and tries again (`hearth/offline.rs`). The window is a plain web page: it gets none of this
  app's commands (those stay with the `main` and `recording_overlay` windows in
  `capabilities/`). Keep it that way.
- **Connecting.** In Hearth in your browser, Settings → Desktop app → Connect Hearth on this PC.
  Windows hands the `hearth://connect` link to this app, which asks you, then gets its own token
  and signs its window in (`hearth/deeplink.rs`). Then Windows Hello makes the window a key, so
  it can sign itself in again: the sign-in page's "Sign in with Windows Hello" asks this app, and
  Windows Hello signs Hearth's challenge (`hearth/hello.rs`, D80). Pairing with a code, under
  "Pair with a code instead", still works. The token may only run the actions this app needs
  (D42), and on its own it never signs the window in.
- **`hearth://` links** (`hearth/links.rs`): `hearth://open/<page>` opens a page of Hearth,
  `hearth://settings` opens voice settings, `hearth://connect?nonce=…` connects, and
  `hearth://sign-in` (from Hearth's window only) signs the window in with Windows Hello. Any
  website can open them, so they're checked strictly and never say where Hearth is.
- **Notifications** (`hearth/notify.rs`, `toast.rs`): what your phone would be told about, and
  Hearth's health changing, from `/api/desktop/notify`. Quiet while Hearth's window is in front;
  clicking one opens its page.
- **Tray status** (`hearth/status.rs`): "Server ✓ Worker ✓ Jarvis ✓" on the first line, a warning
  icon when something's wrong, and **Restart Hearth services** and **Update Hearth…**
  (`hearth/services.rs`, which finds the Hearth folder from the hearth-server service).
- **Quick capture** (Ctrl+Alt+N): a small window on Hearth's `/capture` page. **Ask Pip**
  (Ctrl+Alt+K): a small box of this app's own over the app you're in (`hearth/quick_ask.rs`).
  What you type goes to Pip after two seconds to undo, with that app's name and window title
  beside it as outside data, never as your words. Esc or clicking elsewhere tucks them away.
- **Dictation** (Handy's hotkey) goes to Hearth's `voice.clean` with the program and window you
  were in. Hearth applies your dictionary, snippets and the app's style, and keeps it in your
  dictation history. If Hearth can't be reached, Handy's own processing is used.
- **Command Jarvis** (Ctrl+Alt+Space): select text, hold, say what to do with it. The selection
  is copied, Jarvis rewrites it in its fast lane, and the answer is pasted over it.
- **Talk to Jarvis** (Ctrl+Alt+J): hold and ask. The answer is read aloud with the Windows voice
  and stays in the conversation in Hearth.
- **Record a meeting** in the tray menu records your microphone ("me") and what the PC plays
  ("them", WASAPI loopback) into the meeting for the calendar event that's on now (or notes you
  opened, or a new one). Each channel is cut at pauses, transcribed on this PC, and added to
  the meeting, whose page opens with the live transcript beside your notes. A spoken reminder
  asks you to tell people you're taking notes. Stopping ends the meeting and Jarvis writes the
  summary.
- **Named Hearth** (`hearth.exe`, identifier `app.hearth.desktop`), installed per user, and
  started with Windows (hidden) by default. Handy's updater is off and its signing key removed,
  so a Handy release never replaces it; updates come from Hearth's own installer for now.
- **Nook arranging windows** (`nook/`, D75, [docs/nook-wm.md](../../docs/nook-wm.md)): off, and in
  this version there is nothing to turn on yet. What is here keeps windows safe whatever happens:
  `hearth.exe --nook-restore-windows` puts back every window Nook arranged (the installer runs it
  before an update or an uninstall, `nsis/hooks.nsh`), Hearth finishes a restore an earlier run
  left owing when it starts, and once Nook can be turned on, `nook-guard.exe`
  (`crates/nook-restore`) does it when Hearth can't. Nook's log is `nook.log` in
  `%LOCALAPPDATA%\app.hearth.desktop\nook`, and a file named `disabled` there keeps Nook off.
  `hearth.exe` is a windowed program, so a terminal doesn't wait for it on its own. In cmd, run
  `start /wait "" "%LOCALAPPDATA%\Hearth\hearth.exe" --nook-restore-windows`, and
  `echo %errorlevel%` then gives 0 when every window came back; in PowerShell,
  `(Start-Process "$env:LOCALAPPDATA\Hearth\hearth.exe" --nook-restore-windows -Wait -PassThru -NoNewWindow).ExitCode`.
  Either way it says what it did; `--quiet` says nothing.

## Building

See [BUILD.md](BUILD.md); the steps are Handy's. On Windows you need Rust, Bun, the Vulkan SDK
and an ONNX Runtime (set `ORT_LIB_LOCATION` and `ORT_PREFER_DYNAMIC_LINK=1`). The `Desktop`
GitHub workflow builds the Windows installer whenever this folder changes, versioned
`1.0.<run number>` so each one installs as an upgrade; a local build is `1.0.0`.

On Windows, `tauri build` first runs `bun run build:guard`, which builds `nook-guard.exe` from
`src-tauri/crates/nook-restore` into `src-tauri/binaries/`. Other builds (`cargo test`,
`tauri dev`, the bake-off) get a stand-in from `build.rs`, which a `tauri build` refuses.

A development build doesn't register `hearth://` links or touch the startup list: both belong to
the installed app, and a dev build would take them over.

This folder isn't part of the pnpm workspace; it uses Bun, like Handy.

## The speech bake-off

Hearth's plan picks the speech engine by testing them on your own voice (PLAN.md section 7.1).
Record samples on Hearth's Voice page, under Voice samples; they're saved in Hearth's data folder
under `voice-samples`, with `vocabulary.txt` made from your dictionary. Then, with the model files this app downloaded (Settings → Models):

    cargo run --release --bin bakeoff -- <data folder>\voice-samples ^
      parakeet=<models>\<Parakeet v3 .gguf> whisper=<models>\<Whisper large v3 turbo .gguf> ^
      parakeet-cpu=<models>\<Parakeet v3 .gguf>

Each `label=file` runs on the GPU when there is one; a label ending in `-cpu` runs on the CPU.
It prints word error rate, how often your vocabulary came out right (Whisper is primed with it;
Parakeet can't be), median and slowest-5% time per sample, load time and GPU memory (NVIDIA
only), and saves the table beside the samples.
