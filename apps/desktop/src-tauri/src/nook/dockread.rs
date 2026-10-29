// What the agent dock reads of Windows (dockwin.rs reads it every few seconds while the dock is
// made): whether something fullscreen is in front, Windows' text size, where the pointer is, and
// the primary monitor with its work area.

use super::bar::Place;
use super::dock;
use super::probe::Rect;
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// Whether Windows' notification state (SHQueryUserNotificationState) says something fullscreen
/// is in front, a presentation is on, or nobody is there to see the dock.
pub fn busy(quns: i32) -> bool {
    // QUNS_NOT_PRESENT, _BUSY, _RUNNING_D3D_FULL_SCREEN, _PRESENTATION_MODE and _APP; not
    // _ACCEPTS_NOTIFICATIONS or _QUIET_TIME.
    matches!(quns, 1..=4 | 7)
}

/// Windows' notification state: something fullscreen, a presentation, or nobody there.
pub fn busy_now() -> bool {
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => busy(state.0),
        Err(_) => false,
    }
}

/// Windows' text size (Settings > Accessibility > Text size), which it keeps as TextScaleFactor
/// only while it is above 100 %. The bar reads it too (barwin.rs).
pub fn text_now() -> u32 {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let raw = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Accessibility")
        .and_then(|k| k.get_value::<u32, _>("TextScaleFactor"))
        .ok();
    dock::text_size(raw)
}

/// Where the pointer is, in physical px.
pub fn cursor() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    Some((p.x, p.y))
}

/// The primary monitor, which always holds the point (0, 0), and its work area, in physical px.
pub fn primary() -> Option<(Place, Rect)> {
    let h = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(h, &mut info) }.as_bool() {
        return None;
    }
    let (mut dx, mut dy) = (96u32, 96u32);
    let _ = unsafe { GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    let rect = |r: windows::Win32::Foundation::RECT| Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    };
    let at = Place {
        rect: rect(info.rcMonitor),
        dpi: dx,
    };
    Some((at, rect(info.rcWork)))
}
