// The Win32 and WebView2 calls the bar makes, every one of them on Nook's own windows and on the
// main thread (docs/nook-wm.md, "BAR BUILDER", "GLASS" and "FULLSCREEN AND GAMES"), and the few
// settings of Windows the bar reads. None of this goes near another app's window: the bar's only
// write outside its own windows is handing the foreground back after a click (focus.rs).

use super::probe::Rect;
use std::ffi::c_void;
use tauri::{Runtime, WebviewWindow};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
};
use webview2_com::TrySuspendCompletedHandler;
use windows::core::Interface;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
};
use windows::Win32::UI::Accessibility::{HCF_HIGHCONTRASTON, HIGHCONTRASTW};
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SendMessageW, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    SystemParametersInfoW, GWL_EXSTYLE, HWND_TOP, SPI_GETCLIENTAREAANIMATION, SPI_GETHIGHCONTRAST,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE,
    SW_SHOWNOACTIVATE, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WM_NCACTIVATE, WS_EX_NOACTIVATE,
    WS_EX_TOOLWINDOW,
};

fn hwnd<R: Runtime>(w: &WebviewWindow<R>) -> Option<HWND> {
    w.hwnd().ok()
}

/// After creation: a tool window that is never activated, with square corners, so DWM neither
/// clips nor outlines it. Overlay mode keeps it out of Alt-Tab and the taskbar and leaves the
/// work area alone.
pub fn own_style<R: Runtime>(w: &WebviewWindow<R>) {
    let Some(h) = hwnd(w) else {
        return;
    };
    unsafe {
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE);
        let want = ex | (WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0) as isize;
        if want != ex {
            SetWindowLongPtrW(h, GWL_EXSTYLE, want);
            let _ = SetWindowPos(
                h,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOMOVE | SWP_NOSIZE,
            );
        }
        let corner = DWMWCP_DONOTROUND;
        let _ = DwmSetWindowAttribute(
            h,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            &corner as *const _ as *const c_void,
            std::mem::size_of_val(&corner) as u32,
        );
    }
}

/// Moves and sizes the window in physical px, without activating it or changing its place in
/// the z-order.
pub fn place<R: Runtime>(w: &WebviewWindow<R>, r: Rect) {
    if let Some(h) = hwnd(w) {
        let flags = SWP_NOACTIVATE | SWP_NOZORDER;
        let _ = unsafe { SetWindowPos(h, None, r.left, r.top, r.width(), r.height(), flags) };
    }
}

/// Shown without taking the foreground, at the top of the non-topmost windows. tao's show()
/// would activate it.
pub fn show<R: Runtime>(w: &WebviewWindow<R>) {
    if let Some(h) = hwnd(w) {
        unsafe {
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
            let flags = SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE;
            let _ = SetWindowPos(h, Some(HWND_TOP), 0, 0, 0, 0, flags);
        }
    }
}

pub fn hide<R: Runtime>(w: &WebviewWindow<R>) {
    if let Some(h) = hwnd(w) {
        let _ = unsafe { ShowWindow(h, SW_HIDE) };
    }
}

/// A window that is never activated may draw without its acrylic, so it is told once that it
/// is active, which changes nothing else.
pub fn nc_activate<R: Runtime>(w: &WebviewWindow<R>) {
    if let Some(h) = hwnd(w) {
        unsafe { SendMessageW(h, WM_NCACTIVATE, Some(WPARAM(1)), Some(LPARAM(0))) };
    }
}

/// While hidden, the page is invisible to its renderer, at low memory, and suspended; Rust wakes
/// it before showing it again.
pub fn sleep<R: Runtime>(w: &WebviewWindow<R>) {
    let _ = w.with_webview(|pw| unsafe {
        let controller = pw.controller();
        let _ = controller.SetIsVisible(false);
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
            let _ = c19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
        }
        if let Ok(c3) = core.cast::<ICoreWebView2_3>() {
            let done = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
            if let Err(e) = c3.TrySuspend(&done) {
                log::debug!("Nook's bar page didn't suspend: {e}");
            }
        }
    });
}

pub fn wake<R: Runtime>(w: &WebviewWindow<R>) {
    let _ = w.with_webview(|pw| unsafe {
        let controller = pw.controller();
        if let Ok(core) = controller.CoreWebView2() {
            if let Ok(c3) = core.cast::<ICoreWebView2_3>() {
                let _ = c3.Resume();
            }
            if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
                let _ =
                    c19.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
            }
        }
        let _ = controller.SetIsVisible(true);
    });
}

/// What Windows says about drawing, read fresh each time: the bar's look follows it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Readings {
    pub high_contrast: bool,
    /// Transparency effects are on (Settings > Personalization > Colors).
    pub transparency: bool,
    /// "Animation effects" is off (Settings > Accessibility > Visual effects).
    pub reduced_motion: bool,
    /// Apps are in dark mode.
    pub dark: bool,
}

pub fn readings() -> Readings {
    let mut hc = HIGHCONTRASTW {
        cbSize: std::mem::size_of::<HIGHCONTRASTW>() as u32,
        ..Default::default()
    };
    let none = SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0);
    let high_contrast = unsafe {
        SystemParametersInfoW(
            SPI_GETHIGHCONTRAST,
            hc.cbSize,
            Some(&mut hc as *mut _ as *mut c_void),
            none,
        )
    }
    .is_ok()
        && hc.dwFlags.contains(HCF_HIGHCONTRASTON);
    let mut animate = windows::core::BOOL(1);
    let read = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            Some(&mut animate as *mut _ as *mut c_void),
            none,
        )
    };
    let personalize = personalize();
    Readings {
        high_contrast,
        // Transparency is on unless Windows says it's off.
        transparency: personalize.0 != Some(0),
        reduced_motion: read.is_ok() && !animate.as_bool(),
        dark: personalize.1 == Some(0),
    }
}

/// EnableTransparency and AppsUseLightTheme, as sight.rs reads the latter.
fn personalize() -> (Option<u32>, Option<u32>) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
    else {
        return (None, None);
    };
    (
        key.get_value::<u32, _>("EnableTransparency").ok(),
        key.get_value::<u32, _>("AppsUseLightTheme").ok(),
    )
}
