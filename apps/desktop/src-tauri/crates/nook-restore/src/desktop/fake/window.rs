// One fake window, and the show and placement rules FakeDesktop applies to it. Show commands
// follow Win32: restoring a window that was minimized from maximized brings it back maximized,
// and restoring a maximized one makes it normal.

use crate::desktop::BORDER_DEFAULT;
use crate::placement::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FakeWindow {
    pub pid: u32,
    pub class: String,
    /// As GetWindowPlacement would report it.
    pub placement: Placement,
    pub visible: bool,
    pub cloaked: bool,
    pub marker: Option<u32>,
    pub border: u32,
    pub transitions_disabled: bool,
}

impl FakeWindow {
    pub fn new(pid: u32, class: &str, rect: Rect) -> FakeWindow {
        FakeWindow {
            pid,
            class: class.to_string(),
            placement: Placement::normal(rect),
            visible: true,
            cloaked: false,
            marker: None,
            border: BORDER_DEFAULT,
            transitions_disabled: false,
        }
    }

    pub fn maximized(mut self) -> FakeWindow {
        show(&mut self, SW_SHOWMAXIMIZED);
        self
    }

    pub fn minimized(mut self) -> FakeWindow {
        show(&mut self, SW_SHOWMINIMIZED);
        self
    }

    pub fn hidden(mut self) -> FakeWindow {
        self.visible = false;
        self
    }
}

/// Applies a show command the way ShowWindow does.
pub(super) fn show(win: &mut FakeWindow, show_cmd: u32) {
    let p = &mut win.placement;
    let restore_max = p.restores_maximized();
    let next = match show_cmd {
        SW_HIDE => {
            win.visible = false;
            return;
        }
        SW_SHOWMINIMIZED | SW_MINIMIZE | SW_SHOWMINNOACTIVE => {
            if !p.is_minimized() {
                p.flags = if p.is_maximized() {
                    WPF_RESTORETOMAXIMIZED
                } else {
                    0
                };
            }
            SW_SHOWMINIMIZED
        }
        SW_SHOWMAXIMIZED => SW_SHOWMAXIMIZED,
        SW_SHOW | SW_SHOWNA => p.show_cmd,
        _ if p.is_minimized() && restore_max => SW_SHOWMAXIMIZED,
        _ => SW_SHOWNORMAL,
    };
    if next != SW_SHOWMINIMIZED {
        p.flags = 0;
    }
    p.show_cmd = next;
    win.visible = true;
}

/// Applies a SetWindowPlacement: positions first, then the show command, then the
/// restore-to-maximized flag, which Windows honours only on a minimized result.
pub(super) fn place(win: &mut FakeWindow, p: &Placement) {
    win.placement.normal_position = p.normal_position;
    win.placement.min_position = p.min_position;
    win.placement.max_position = p.max_position;
    show(win, p.show_cmd);
    if win.placement.is_minimized() && p.flags & WPF_RESTORETOMAXIMIZED != 0 {
        win.placement.flags = WPF_RESTORETOMAXIMIZED;
    }
}
