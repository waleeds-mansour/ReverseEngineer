// Nook arranges the windows on the owner's PC (docs/nook-wm.md, D75). This is the app's side of
// it: where Nook's files live, what it checks when Hearth starts and does on the way out, the
// tray's two items, and the command the settings window calls before an update. The window
// manager itself comes in later phases. In this one every capability is off and there is none to
// turn on, so Nook installs no hook, registers no hotkey, creates no window and starts no thread,
// except to finish a restore that an earlier run left owing. That restore is nook-restore's, the
// same one the --nook-restore-windows CLI, nook-guard.exe and the installer run.

#[cfg(windows)]
mod diag;
#[cfg(windows)]
mod host;
#[cfg(all(test, windows))]
mod off;
#[cfg(windows)]
mod settings;
#[cfg(windows)]
mod start;
#[cfg(windows)]
mod unwind;

use tauri::AppHandle;

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
