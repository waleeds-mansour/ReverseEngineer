// Is this still the window Nook journaled? Windows reuses window handles and process ids, so a
// handle alone could point at another app's window by the time a restore runs. A restore writes
// to a window only when the handle, the owning process, that process's start time and Nook's
// marker (or, once the marker is gone, the window class) all still match (docs/nook-wm.md,
// "IDENTITY CHECK BEFORE ANY RECOVERY WRITE").

use crate::desktop::Desktop;
use crate::journal::WindowEntry;
use crate::placement::Hwnd;
use serde::{Deserialize, Serialize};

/// The bits of Nook's marker property on a window it changed.
pub mod marker {
    pub const MANAGED: u32 = 1;
    pub const MINIMIZED: u32 = 2;
    pub const CLOAKED: u32 = 4;
    pub const BORDER: u32 = 8;
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Identity {
    pub hwnd: Hwnd,
    pub pid: u32,
    pub proc_start: u64,
    pub class: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mismatch {
    /// The window no longer exists.
    Gone,
    /// The handle now belongs to another process.
    OtherProcess,
    /// The process id was reused: same pid, a later start.
    Reused,
    /// Same process, but neither the marker nor the class matches: the app made a new window
    /// that got the old handle.
    OtherWindow,
}

impl Identity {
    /// Reads who owns `hwnd` now, for the journal entry Nook writes before it adopts the window.
    pub fn capture(desktop: &dyn Desktop, hwnd: Hwnd) -> Option<Identity> {
        let pid = desktop.window_pid(hwnd)?;
        Some(Identity {
            hwnd,
            pid,
            proc_start: desktop.process_start(pid)?,
            class: desktop.class_name(hwnd)?,
        })
    }

    pub fn of(entry: &WindowEntry) -> Identity {
        Identity {
            hwnd: entry.hwnd,
            pid: entry.pid,
            proc_start: entry.proc_start,
            class: entry.class.clone(),
        }
    }

    /// Ok when it is still the same window. Anything Nook can't read counts as a mismatch, so a
    /// doubt always means no write.
    pub fn verify(&self, desktop: &dyn Desktop) -> Result<(), Mismatch> {
        if !desktop.is_window(self.hwnd) {
            return Err(Mismatch::Gone);
        }
        if desktop.window_pid(self.hwnd) != Some(self.pid) {
            return Err(Mismatch::OtherProcess);
        }
        if desktop.process_start(self.pid) != Some(self.proc_start) {
            return Err(Mismatch::Reused);
        }
        let marked = desktop.marker(self.hwnd).is_some();
        if !marked && desktop.class_name(self.hwnd).as_deref() != Some(self.class.as_str()) {
            return Err(Mismatch::OtherWindow);
        }
        Ok(())
    }
}
