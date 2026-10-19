// Nook's own windows and their one command (docs/nook-wm.md, "IPC" and "LOCAL SURFACE"). The
// panel is a bundled local page, so Tauri treats it as a local origin; capabilities/nook.json
// gives Nook's windows nothing but listening for events. nook_ui answers only Nook's own windows,
// by label and by a local address, and every argument it takes is an enum. State goes the other
// way as 'nook://state', the full state to the panel and the state without the window list to
// every other Nook window, where the bar and the popover listen, and as 'nook://chrome', the
// theme, services and Pip. A bar or popover that is asleep is sent nothing until it wakes.

use super::bar::{BAR_LABEL, POPOVER_LABEL};
use super::chrome::{ChromeView, CHROME_EVENT};
use super::host::{self, Shared};
use super::view::{NookState, UiCmd, UiReply, STATE_EVENT};
use super::wm::Cmd;
use super::{barwin, look, observe, settings};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const PANEL: &str = "nook_panel";
const PANEL_PAGE: &str = "src/nook/panel.html";

/// The labels of Nook's windows: the panel, the bar and its popover, and the palette later.
pub fn is_nook_label(label: &str) -> bool {
    matches!(label, PANEL | POPOVER_LABEL | "nook_palette") || label.starts_with("nook_bar_")
}

/// What each of Nook's pages may ask: the panel its switches and files, the bar and popover
/// only what they draw.
fn allowed(label: &str, cmd: &UiCmd) -> bool {
    let chrome = matches!(label, BAR_LABEL | POPOVER_LABEL);
    match cmd {
        UiCmd::Ready => true,
        // Refresh judges every window again, which only the panel's list needs.
        UiCmd::Refresh
        | UiCmd::SetObserve { .. }
        | UiCmd::SetBar { .. }
        | UiCmd::SaveFixtures
        | UiCmd::ExportDiag => label == PANEL,
        UiCmd::Drawn | UiCmd::OpenToday | UiCmd::Popover { .. } => chrome,
    }
}

/// A page bundled with Hearth, or, while developing, Vite's dev server.
pub fn is_local(app: &AppHandle, url: &Url) -> bool {
    let bundled = url.scheme() == "tauri"
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let dev = tauri::is_dev()
        && app
            .config()
            .build
            .dev_url
            .as_ref()
            .is_some_and(|d| d.origin() == url.origin());
    bundled || dev
}

/// Whether any of Nook's windows is open.
pub fn any_open(app: &AppHandle) -> bool {
    app.webview_windows().keys().any(|l| is_nook_label(l))
}

/// Sends the state to every open Nook window that is awake, and tells the bar. Called on
/// nook-wm, and it never waits.
pub fn emit(app: &AppHandle, state: &NookState) {
    let shared = host::shared(app);
    if let Some(s) = &shared {
        barwin::on_state(s, state);
    }
    let awake = |label: &str| shared.as_ref().is_none_or(|s| s.bar().receives(label));
    let mut short: Option<NookState> = None;
    for label in app.webview_windows().into_keys() {
        if !is_nook_label(&label) || !awake(&label) {
            continue;
        }
        let sent = if label == PANEL {
            app.emit_to(label.as_str(), STATE_EVENT, state)
        } else {
            let s = short.get_or_insert_with(|| state.without_windows());
            app.emit_to(label.as_str(), STATE_EVENT, &*s)
        };
        if let Err(e) = sent {
            log::debug!("Couldn't send Nook's state to {label}: {e}");
        }
    }
}

/// Sends a new chrome view to every open Nook window that is awake.
pub fn emit_chrome(app: &AppHandle, view: &ChromeView) {
    let shared = host::shared(app);
    let awake = |label: &str| shared.as_ref().is_none_or(|s| s.bar().receives(label));
    for label in app.webview_windows().into_keys() {
        if is_nook_label(&label) && awake(&label) {
            if let Err(e) = app.emit_to(label.as_str(), CHROME_EVENT, view) {
                log::debug!("Couldn't send Nook's chrome to {label}: {e}");
            }
        }
    }
}

/// A bar or popover that just woke gets what it missed while asleep.
pub fn send_latest(shared: &Shared, label: &str) {
    let state = shared
        .snapshot
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .without_windows();
    let chrome = look::fresh(shared);
    let _ = shared.app.emit_to(label, STATE_EVENT, &state);
    let _ = shared.app.emit_to(label, CHROME_EVENT, &chrome);
}

/// Opens the panel, or brings it forward. Opening it starts observing. This comes from a
/// page's navigation or new-window handler, or the deep-link callback, all on the main thread,
/// where building a WebView2 window can deadlock (wry#583); so the panel is made on a worker,
/// as the bar is, and observing starts from there too.
pub fn open_panel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PANEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || make_panel(&app));
}

/// One panel at a time, when two clicks both find none.
static MAKING: Mutex<()> = Mutex::new(());

fn make_panel(app: &AppHandle) {
    let _one = MAKING.lock().unwrap_or_else(|p| p.into_inner());
    if app.get_webview_window(PANEL).is_some() {
        return;
    }
    let nav = app.clone();
    let mut b = WebviewWindowBuilder::new(app, PANEL, WebviewUrl::App(PANEL_PAGE.into()))
        .title("Nook: Arrange windows (preview)")
        .inner_size(1000.0, 720.0)
        .min_inner_size(640.0, 480.0)
        .center()
        // The panel stays on its own page; it has no links to follow.
        .on_navigation(move |to| is_local(&nav, to));
    if let Some(data) = crate::portable::data_dir() {
        b = b.data_directory(data.join("webview"));
    }
    match b.build() {
        Ok(_) => host::panel(app, true),
        Err(e) => log::warn!("Couldn't open Nook's panel: {e}"),
    }
}

/// The panel really closes, which ends the observing it started; Hearth's other windows hide.
pub fn closes(label: &str) -> bool {
    label == PANEL
}

/// The bar and popover neither close nor hide when asked: their switch decides.
pub fn stays(label: &str) -> bool {
    matches!(label, BAR_LABEL | POPOVER_LABEL)
}

pub fn destroyed(app: &AppHandle, label: &str) {
    if label == PANEL {
        host::panel(app, false);
    }
}

/// nook_ui's checks, then the command.
pub async fn command(webview: tauri::Webview, cmd: UiCmd) -> Result<UiReply, String> {
    let app = webview.app_handle().clone();
    let local = webview.url().map(|u| is_local(&app, &u)).unwrap_or(false);
    let label = webview.label().to_string();
    if !is_nook_label(&label) || !local {
        return Err("only Nook's own windows may ask this".into());
    }
    if !allowed(&label, &cmd) {
        return Err("this page of Nook can't ask that".into());
    }
    let Some(shared) = host::shared(&app) else {
        return Err("Nook didn't start".into());
    };
    // Stopping the observer can wait up to a second, which mustn't hold up the IPC thread.
    tauri::async_runtime::spawn_blocking(move || handle(&shared, &label, cmd))
        .await
        .map_err(|e| e.to_string())?
}

fn handle(shared: &Arc<Shared>, label: &str, cmd: UiCmd) -> Result<UiReply, String> {
    let saved = match cmd {
        UiCmd::Ready => None,
        UiCmd::Refresh => {
            if let Some(link) = shared.observer().link() {
                link.send(Cmd::Refresh);
            }
            None
        }
        UiCmd::SetObserve { on } => {
            settings::save_observe(&shared.app, on)?;
            let mut o = shared.observer();
            o.setting = on;
            if let Some(link) = o.link() {
                link.send(Cmd::Observe(on));
            }
            observe::sync_with(shared, &mut o);
            None
        }
        UiCmd::SaveFixtures => Some(ask(shared, Cmd::SaveFixtures)?),
        UiCmd::ExportDiag => Some(ask(shared, |r| Cmd::ExportDiag(Some(r)))?),
        UiCmd::SetBar { on } => {
            settings::save_bar(&shared.app, on)?;
            shared.bar().setting = on;
            barwin::sync(shared);
            None
        }
        UiCmd::Drawn => {
            barwin::drawn(shared, label);
            None
        }
        UiCmd::Popover { open } => {
            barwin::popover(shared, open);
            None
        }
        UiCmd::OpenToday => {
            crate::hearth::window::open(&shared.app, "/today");
            barwin::popover(shared, false);
            None
        }
    };
    let state = {
        let o = shared.observer();
        observe::current(shared, &o)
    };
    Ok(UiReply {
        state: if label == PANEL {
            state
        } else {
            state.without_windows()
        },
        saved,
        chrome: look::fresh(shared),
    })
}

/// A command that writes a file, asked of nook-wm without holding the observer's lock.
fn ask(shared: &Shared, make: impl FnOnce(super::wm::Reply) -> Cmd) -> Result<String, String> {
    let link = shared.observer().link().cloned();
    let link = link.ok_or("Nook isn't observing, so there is nothing to save")?;
    link.ask(make).map(|p| p.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_nooks_labels_pass() {
        for ok in ["nook_panel", "nook_popover", "nook_palette", "nook_bar_1"] {
            assert!(is_nook_label(ok), "{ok}");
        }
        for no in [
            "hearth",
            "main",
            "hearth_ask",
            "recording_overlay",
            "nook",
            "nook_bar",
            "xnook_panel",
        ] {
            assert!(!is_nook_label(no), "{no}");
        }
    }

    #[test]
    fn the_bar_may_ask_only_what_it_draws() {
        for cmd in [UiCmd::Ready, UiCmd::Drawn, UiCmd::Popover { open: true }] {
            assert!(allowed(BAR_LABEL, &cmd), "{cmd:?}");
        }
        for cmd in [
            UiCmd::Refresh,
            UiCmd::SetObserve { on: true },
            UiCmd::SetBar { on: false },
            UiCmd::SaveFixtures,
            UiCmd::ExportDiag,
        ] {
            assert!(!allowed(BAR_LABEL, &cmd), "{cmd:?}");
            assert!(!allowed(POPOVER_LABEL, &cmd), "{cmd:?}");
            assert!(allowed(PANEL, &cmd), "{cmd:?}");
        }
        assert!(allowed(POPOVER_LABEL, &UiCmd::OpenToday));
        assert!(!allowed(PANEL, &UiCmd::Drawn));
        assert!(stays(BAR_LABEL) && stays(POPOVER_LABEL) && !stays(PANEL));
    }
}
