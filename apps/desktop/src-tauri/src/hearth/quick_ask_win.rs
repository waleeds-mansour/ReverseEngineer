// What the quick-ask box (quick_ask.rs) asks of Windows itself: its own window's handle, which
// Nook counts as one of its own, the monitor the app it opened over is on, and giving that app
// the focus back. Away from Windows there is no box, and these do nothing.

use super::quick_ask_parts::Over;
use tauri::AppHandle;

/// The box's window, which Nook counts as one of its own (host.rs, own_windows).
#[cfg(windows)]
pub fn hwnd(app: &AppHandle) -> Option<isize> {
    use tauri::Manager;
    let w = app.get_webview_window(super::quick_ask::LABEL)?;
    w.hwnd().ok().map(|h| h.0 as isize)
}

/// The work area, in physical px, and DPI of the monitor that window is on (the primary when
/// there is none).
#[cfg(windows)]
pub(super) fn spot(at: Option<isize>) -> Option<((i32, i32, i32, i32), u32)> {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    let monitor = unsafe {
        match at {
            Some(h) => MonitorFromWindow(HWND(h as *mut _), MONITOR_DEFAULTTONEAREST),
            None => MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY),
        }
    };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return None;
    }
    let (mut dx, mut dy) = (96u32, 96u32);
    let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    let r = info.rcWork;
    Some(((r.left, r.top, r.right, r.bottom), dx))
}

/// The focus back to the window the box opened over, if it is still that app's, and not
/// minimized. Nothing else about it changes.
#[cfg(windows)]
pub(super) fn give_back(over: &Over) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow,
    };
    let h = HWND(over.hwnd as *mut _);
    let mut pid = 0u32;
    unsafe {
        if !IsWindow(Some(h)).as_bool() || IsIconic(h).as_bool() {
            return;
        }
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == over.pid {
            let _ = SetForegroundWindow(h);
        }
    }
}

#[cfg(not(windows))]
pub fn hwnd(_app: &AppHandle) -> Option<isize> {
    None
}

#[cfg(not(windows))]
pub(super) fn spot(_at: Option<isize>) -> Option<((i32, i32, i32, i32), u32)> {
    None
}

#[cfg(not(windows))]
pub(super) fn give_back(_over: &Over) {}
