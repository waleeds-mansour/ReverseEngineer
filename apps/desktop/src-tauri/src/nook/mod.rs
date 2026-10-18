// Nook arranges the windows on the owner's PC (docs/nook-wm.md, D75). This is the app's side of
// it: where Nook's files live, what it checks when Hearth starts and does on the way out, the
// tray's two items, the command the settings window calls before an update, and P1's observer
// with its panel. Observing watches every window and decides what Nook would do with it, and
// writes to none: each write goes to nook-restore's seam in its read-only mode and is refused.
// It runs only while the panel is open or the owner's observing switch is on, which starts off.
// P1's bar along the top of DISPLAY1 has a switch of its own, also off, and observes while it is
// on. Otherwise Nook installs no hook, registers no hotkey, creates no window and starts no
// thread, except to finish a restore that an earlier run left owing. That restore is
// nook-restore's, the same one the --nook-restore-windows CLI, nook-guard.exe and the installer
// run.

#[cfg(windows)]
mod bar;
#[cfg(windows)]
mod barwin;
pub mod chrome;
#[cfg(windows)]
mod coalesce;
#[cfg(windows)]
mod diag;
#[cfg(windows)]
mod eligibility;
#[cfg(all(test, windows))]
mod fake;
#[cfg(windows)]
mod focus;
#[cfg(windows)]
mod game;
#[cfg(windows)]
mod gates;
#[cfg(windows)]
mod hooks;
#[cfg(windows)]
mod host;
#[cfg(all(test, windows))]
mod itest;
#[cfg(windows)]
mod look;
#[cfg(windows)]
mod monitors;
#[cfg(windows)]
mod observe;
#[cfg(all(test, windows))]
mod off;
#[cfg(windows)]
mod perf;
#[cfg(windows)]
mod pip;
#[cfg(windows)]
mod probe;
#[cfg(windows)]
mod process;
#[cfg(windows)]
mod rules;
#[cfg(windows)]
mod seam;
#[cfg(windows)]
mod settings;
#[cfg(windows)]
mod shell;
#[cfg(windows)]
mod start;
#[cfg(windows)]
mod surface;
#[cfg(windows)]
mod sync;
#[cfg(windows)]
mod ui;
#[cfg(windows)]
mod unwind;
#[cfg(windows)]
mod vd;
pub mod view;
#[cfg(windows)]
mod why;
#[cfg(windows)]
mod window;
#[cfg(windows)]
mod wm;

pub use chrome::{PipMood, ThemeId};
use tauri::AppHandle;
pub use view::{UiCmd, UiReply};

/// The tray's items, offered only while Nook arranges windows.
pub const TRAY_PAUSE: &str = "nook_pause";
pub const TRAY_PUT_BACK: &str = "nook_put_back";

/// Reads Nook's switches and journal. Called once, from initialize_core_logic.
pub fn init(app: &AppHandle) {
    host::init(app);
}

/// Hearth is quitting: a restore that is still running gets a moment to finish.
pub fn shutdown(app: &AppHandle) {
    host::shutdown(app);
}

/// Whether Nook arranges windows now, which is when the tray shows Pause and Put back.
pub fn arranging(app: &AppHandle) -> bool {
    host::arranging(app)
}

/// The tray's Pause and Put back. They are shown only while Nook arranges windows, which nothing
/// does in this version, so they have nothing to do yet.
pub fn tray_action(_app: &AppHandle, id: &str) {
    log::info!("Nook's tray item {id} has nothing to do in this version");
}

/// Shows what Nook hid, keeping every window where it is, before the updater replaces Hearth: a
/// version that is about to be gone must not leave a window minimized. The installer's PREINSTALL
/// hook runs the same restore through the CLI; this runs first, while Hearth can still answer. An
/// error is for the log only, and the update goes ahead either way.
#[tauri::command]
#[specta::specta]
pub async fn prepare_update(app: AppHandle) -> Result<(), String> {
    host::prepare_update(app).await
}

/// The one command Nook's own pages call. Only Nook's windows on a local page get an answer, and
/// every argument is one of UiCmd's few cases, none of which changes a window.
#[tauri::command]
#[specta::specta]
pub async fn nook_ui(webview: tauri::Webview, cmd: UiCmd) -> Result<UiReply, String> {
    ui::command(webview, cmd).await
}

/// Whether a page may call an app command: Nook's pages, by their nook_ label, only nook_ui.
/// Their capability (capabilities/nook.json) lets them listen for events and nothing more, but
/// this app has no app manifest, so its own commands aren't held to capabilities; lib.rs's invoke
/// handler asks this first. Plugin commands never reach it and stay with the capability.
pub fn may_invoke(label: &str, command: &str) -> bool {
    !label.starts_with("nook_") || command == "nook_ui"
}

/// Opens Nook's panel, from the hearth://nook-panel link in Settings.
pub fn open_panel(app: &AppHandle) {
    ui::open_panel(app);
}

/// Whether closing this window should really close it; Hearth's other windows only hide.
pub fn closes(label: &str) -> bool {
    ui::closes(label)
}

/// A window has gone; when it is the panel, observing may stop.
pub fn destroyed(app: &AppHandle, label: &str) {
    ui::destroyed(app, label);
}

/// The bar and popover don't close or hide when asked; their switch decides.
pub fn stays(label: &str) -> bool {
    ui::stays(label)
}

/// One of Hearth's windows came to the front: the bar hands it back after a click, and Hearth's
/// own window being looked at clears what waits on the Pip chip.
pub fn focused(app: &AppHandle, label: &str) {
    barwin::focused(app, label);
}

/// hearth://theme/<id>, from one of Hearth's own windows only.
pub fn theme(app: &AppHandle, id: ThemeId) {
    look::theme(app, id);
}

/// The tray's status of Hearth's services changed.
pub fn services_changed(app: &AppHandle) {
    look::services_changed(app);
}

/// Pip is listening, thinking, or has answered, as far as this PC's own calls to it go.
pub fn pip(app: &AppHandle, mood: PipMood) {
    look::set_mood(app, mood);
}

/// The stop key: Pip stops listening or thinking.
pub fn pip_cancelled(app: &AppHandle) {
    look::pip(app, |p| (p.cancelled(), None));
}

/// The recording overlay went away: a recording that never reached Pip stops listening.
pub fn pip_ended(app: &AppHandle) {
    look::pip(app, |p| (p.ended(), None));
}

/// Hearth sent this PC a notification, like an approval waiting.
pub fn pip_notified(app: &AppHandle) {
    look::pip(app, |p| (p.notified(), None));
}

/// Nook arranges windows only on Windows; elsewhere there is nothing to check or put back.
#[cfg(not(windows))]
mod host {
    use tauri::AppHandle;

    pub fn init(_app: &AppHandle) {}

    pub fn shutdown(_app: &AppHandle) {}

    pub fn arranging(_app: &AppHandle) -> bool {
        false
    }

    pub async fn prepare_update(_app: AppHandle) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(not(windows))]
mod barwin {
    pub fn focused(_app: &tauri::AppHandle, _label: &str) {}
}

#[cfg(not(windows))]
mod look {
    use super::{PipMood, ThemeId};
    use tauri::AppHandle;

    pub struct Pip;
    impl Pip {
        pub fn cancelled(&mut self) -> bool {
            false
        }
        pub fn notified(&mut self) -> bool {
            false
        }
        pub fn ended(&mut self) -> bool {
            false
        }
    }

    pub fn theme(_app: &AppHandle, _id: ThemeId) {}
    pub fn services_changed(_app: &AppHandle) {}
    pub fn set_mood(_app: &AppHandle, _mood: PipMood) {}
    pub fn pip(_app: &AppHandle, _f: impl FnOnce(&mut Pip) -> (bool, Option<()>)) {}
}

#[cfg(not(windows))]
mod ui {
    use super::{UiCmd, UiReply};
    use tauri::AppHandle;

    pub async fn command(_webview: tauri::Webview, _cmd: UiCmd) -> Result<UiReply, String> {
        Err("Nook arranges windows only on Windows".into())
    }

    pub fn open_panel(_app: &AppHandle) {}

    pub fn closes(_label: &str) -> bool {
        false
    }

    pub fn destroyed(_app: &AppHandle, _label: &str) {}

    pub fn stays(_label: &str) -> bool {
        false
    }
}

#[cfg(test)]
#[test]
fn nooks_pages_may_call_nook_ui_and_nothing_else() {
    for label in [
        "nook_panel",
        "nook_bar_1",
        "nook_popover",
        "nook_palette",
        "nook_later",
    ] {
        assert!(may_invoke(label, "nook_ui"), "{label}");
        for other in ["get_app_settings", "prepare_update", "change_theme_setting"] {
            assert!(!may_invoke(label, other), "{label} {other}");
        }
    }
    assert!(may_invoke("main", "get_app_settings"));
    assert!(may_invoke("hearth", "prepare_update"));
}

#[cfg(all(test, windows))]
mod tests {
    use super::diag::By;
    use super::host::toast_body;

    #[test]
    fn the_owner_hears_only_about_restores_they_did_not_ask_for() {
        assert_eq!(
            toast_body(By::Start, 7).as_deref(),
            Some(
                "Nook put 7 windows back after it stopped unexpectedly. Arranging is off until \
                 you turn it on."
            )
        );
        assert_eq!(
            toast_body(By::Unwind, 1).as_deref(),
            Some(
                "Nook put 1 window back after a problem in Nook. Arranging is off until you \
                 turn it on."
            )
        );
        assert_eq!(toast_body(By::Start, 0), None);
        assert_eq!(toast_body(By::Update, 3), None);
        assert_eq!(toast_body(By::Retry, 2), None);
    }
}
