// What Nook reads about windows and processes (docs/nook-wm.md, "Which windows Nook manages"),
// behind one trait so the verdict can be tested from fixtures. RealProbe (window.rs and
// process.rs) makes the Win32 calls; the tests' probes answer from tables and count what was
// asked, so a test can prove that a game's process was never opened. Every method only reads.

use serde::{Deserialize, Serialize};

/// A window handle as a number, so it can be a map key and cross threads.
pub type Hwnd = isize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(&self) -> i32 {
        self.right - self.left
    }

    pub fn height(&self) -> i32 {
        self.bottom - self.top
    }

    pub fn contains_point(&self, x: i32, y: i32) -> bool {
        x >= self.left && x < self.right && y >= self.top && y < self.bottom
    }

    pub fn center(&self) -> (i32, i32) {
        (self.left + self.width() / 2, self.top + self.height() / 2)
    }
}

/// Stage A's facts: local user32 reads only, no process opened.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowFacts {
    pub class: String,
    pub pid: u32,
    pub style: u32,
    pub ex_style: u32,
    pub visible: bool,
    /// GetAncestor(GA_ROOT) is the window itself.
    pub root: bool,
    /// GW_OWNER, or 0.
    pub owner: Hwnd,
    /// Its own Alt-Tab root, by the GA_ROOTOWNER and GetLastActivePopup walk.
    pub alt_tab_root: bool,
    /// GetWindowRect, in physical pixels.
    pub rect: Rect,
    pub iconic: bool,
    pub zoomed: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Elevation {
    No,
    Yes,
    /// The token couldn't be read, which Nook treats as elevated.
    #[default]
    Unknown,
}

/// Stage C's facts, from OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessFacts {
    /// The full image path.
    pub path: String,
    /// Creation time as a FILETIME, so a reused pid is never mistaken for the old process.
    pub start: u64,
    pub elevation: Elevation,
}

impl ProcessFacts {
    /// The image's file name, like "chrome.exe".
    pub fn exe(&self) -> &str {
        exe_of(&self.path)
    }
}

pub fn exe_of(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or(path)
}

/// Why a process couldn't be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Closed {
    /// Windows refused even limited access: a protected process.
    Denied,
    /// It exited.
    Gone,
}

pub trait Probe {
    /// None when the window is gone.
    fn window(&self, hwnd: Hwnd) -> Option<WindowFacts>;
    /// DWMWA_CLOAKED; None when the call failed.
    fn cloaked(&self, hwnd: Hwnd) -> Option<u32>;
    /// Opens the process for limited information. Each call counts as one open.
    fn process(&self, pid: u32) -> Result<ProcessFacts, Closed>;
    /// The pid behind a UWP frame, from its Windows.UI.Core.CoreWindow child.
    fn uwp_child_pid(&self, frame: Hwnd) -> Option<u32>;
    /// The stored caption, read without sending a message, for title rules only. Never logged,
    /// never kept, never shown.
    fn title(&self, hwnd: Hwnd) -> Option<String>;

    // Desktop-wide reads.
    fn monitors(&self) -> Vec<super::monitors::Monitor>;
    /// Every top-level window on this thread's desktop.
    fn top_level(&self) -> Vec<Hwnd>;
    fn foreground(&self) -> Option<Hwnd>;
    /// SHQueryUserNotificationState.
    fn notification_state(&self) -> Option<i32>;
    /// False while the secure desktop (UAC, the lock screen) has the input.
    fn input_desktop_ours(&self) -> bool;
    /// SM_REMOTESESSION.
    fn remote_session(&self) -> bool;
    /// The exe's FileDescription.
    fn description(&self, path: &str) -> Option<String>;
}

/// What the verdict needs to know about Nook's own process.
#[derive(Clone, Copy, Debug, Default)]
pub struct Own {
    pub pid: u32,
    pub elevated: bool,
}

pub mod style {
    pub const WS_CHILD: u32 = 0x4000_0000;
    pub const WS_POPUP: u32 = 0x8000_0000;
    pub const WS_DISABLED: u32 = 0x0800_0000;
    pub const WS_CAPTION: u32 = 0x00C0_0000;
    pub const WS_THICKFRAME: u32 = 0x0004_0000;
    pub const WS_MINIMIZEBOX: u32 = 0x0002_0000;
    pub const WS_MAXIMIZEBOX: u32 = 0x0001_0000;
    pub const WS_EX_TOPMOST: u32 = 0x0000_0008;
    pub const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
    pub const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
    pub const WS_EX_APPWINDOW: u32 = 0x0004_0000;
    pub const WS_EX_LAYERED: u32 = 0x0008_0000;
    pub const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exe_is_the_last_part_of_the_path() {
        assert_eq!(exe_of(r"C:\Program Files\App\app.exe"), "app.exe");
        assert_eq!(exe_of("app.exe"), "app.exe");
        assert_eq!(exe_of("C:/x/y.exe"), "y.exe");
    }

    #[test]
    fn a_rect_knows_its_size_and_middle() {
        let r = Rect {
            left: 10,
            top: 20,
            right: 110,
            bottom: 70,
        };
        assert_eq!((r.width(), r.height()), (100, 50));
        assert_eq!(r.center(), (60, 45));
        assert!(r.contains_point(10, 20));
        assert!(!r.contains_point(110, 20));
    }
}
