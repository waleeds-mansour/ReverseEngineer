// The one seam through which Nook reads and changes other apps' windows (docs/nook-wm.md,
// "MODULES"). Every write goes through `check` first: in Observing mode nothing is written, and a
// window manager's writes stop for good once a restorer revokes it, so a stalled window manager
// can never undo a restore. RealDesktop calls Win32; FakeDesktop models it for tests.
//
// The check and the call are two steps, and nothing in Win32 makes them one: a window manager
// preempted between them still lands that one write after a restorer revoked it. The seam
// narrows that race (the check comes right before the call and again after it, so the window
// manager stops at once), it does not close it. Restorers make up for it: a second pass a second
// later, and a late pass after that while the journal's writer still runs.

use crate::placement::{Hwnd, Placement};
use std::fmt;

#[cfg(any(test, feature = "fake"))]
pub mod fake;
#[cfg(windows)]
pub mod real;

/// DWMWA_COLOR_DEFAULT: the border colour Windows draws when nobody chose one.
pub const BORDER_DEFAULT: u32 = 0xFFFF_FFFF;

/// Who is writing, which decides what a write may do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// The panel is open and Nook only looks: every write is refused.
    Observing,
    /// The window manager, holding the journal epoch it claimed. Its writes stop once a
    /// restorer revokes it or a later epoch takes over.
    Managing { epoch: u64 },
    /// A restorer. It revoked everyone else first, so nothing can stop it.
    Restoring,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopError {
    /// A restorer started; this window manager writes nothing more.
    Revoked,
    /// Observing mode.
    ReadOnly,
    /// The window no longer exists.
    Gone,
    /// Windows refused, as it does for an elevated app's window.
    Denied,
    /// Not available in this build (cloaking arrives later, on verified Windows builds only).
    Unsupported,
    /// Any other Win32 error code.
    Os(u32),
}

impl fmt::Display for DesktopError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DesktopError::Revoked => f.write_str("a restore started"),
            DesktopError::ReadOnly => f.write_str("Nook is only looking"),
            DesktopError::Gone => f.write_str("the window is gone"),
            DesktopError::Denied => f.write_str("Windows refused"),
            DesktopError::Unsupported => f.write_str("not available"),
            DesktopError::Os(code) => write!(f, "Windows error {code}"),
        }
    }
}

impl std::error::Error for DesktopError {}

/// Whether a write in `mode` may go ahead. `revoked(epoch)` asks the shared signals; it is only
/// consulted for the window manager, so a restorer never waits on them.
pub fn check(mode: &Mode, revoked: impl FnOnce(u64) -> bool) -> Result<(), DesktopError> {
    match *mode {
        Mode::Restoring => Ok(()),
        Mode::Observing => Err(DesktopError::ReadOnly),
        Mode::Managing { epoch } if revoked(epoch) => Err(DesktopError::Revoked),
        Mode::Managing { .. } => Ok(()),
    }
}

/// Reads and writes on top-level windows. Reads never fail loudly: a window that is gone or
/// can't be read gives None, and the caller treats it as not Nook's.
pub trait Desktop: Send + Sync {
    fn mode(&self) -> Mode;

    fn is_window(&self, hwnd: Hwnd) -> bool;
    /// The process that owns the window.
    fn window_pid(&self, hwnd: Hwnd) -> Option<u32>;
    /// The process's creation time (FILETIME as u64), which tells a reused pid apart.
    fn process_start(&self, pid: u32) -> Option<u64>;
    fn class_name(&self, hwnd: Hwnd) -> Option<String>;
    fn placement(&self, hwnd: Hwnd) -> Option<Placement>;
    fn is_visible(&self, hwnd: Hwnd) -> bool;
    /// Nook's marker bits on the window (identity::marker), if it carries the marker.
    fn marker(&self, hwnd: Hwnd) -> Option<u32>;
    /// Every top-level window on this desktop that carries Nook's marker, with its bits. Only a
    /// restore whose journal is lost or unreadable calls this.
    fn marked(&self) -> Vec<(Hwnd, u32)>;

    /// SetWindowPlacement, asynchronous, so a hung app never blocks Nook.
    fn set_placement(&self, hwnd: Hwnd, placement: &Placement) -> Result<(), DesktopError>;
    /// ShowWindowAsync(SW_SHOWNOACTIVATE): shows a window without taking focus.
    fn show_no_activate(&self, hwnd: Hwnd) -> Result<(), DesktopError>;
    fn uncloak(&self, hwnd: Hwnd) -> Result<(), DesktopError>;
    fn set_marker(&self, hwnd: Hwnd, bits: u32) -> Result<(), DesktopError>;
    fn remove_marker(&self, hwnd: Hwnd) -> Result<(), DesktopError>;
    /// DWMWA_BORDER_COLOR; BORDER_DEFAULT gives the border back to Windows.
    fn set_border_color(&self, hwnd: Hwnd, color: u32) -> Result<(), DesktopError>;
    /// DWMWA_TRANSITIONS_FORCEDISABLED.
    fn set_transitions_disabled(&self, hwnd: Hwnd, disabled: bool) -> Result<(), DesktopError>;
    /// ABM_REMOVE for one of Nook's own AppBar windows.
    fn remove_appbar(&self, hwnd: Hwnd) -> Result<(), DesktopError>;
}
