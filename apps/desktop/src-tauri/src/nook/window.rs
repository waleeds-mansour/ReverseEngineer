// The real probe's window reads (docs/nook-wm.md, "STAGE A" and "STAGE B"): local user32 calls and
// one DWM attribute, none of which sends a message to the window's thread, so a hung app can't
// stall Nook. The title is read with GetWindowTextW, which for another process's window returns
// the stored caption without asking it. Process reads are in process.rs.

use super::probe::{Closed, Hwnd, Probe, ProcessFacts, Rect, WindowFacts};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop,
    DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, HDESK, UOI_NAME,
};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetAncestor, GetClassNameW, GetForegroundWindow,
    GetLastActivePopup, GetSystemMetrics, GetWindow, GetWindowLongPtrW, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, IsZoomed,
    GA_ROOT, GA_ROOTOWNER, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, SM_REMOTESESSION,
};

/// Reads the real desktop: the one this thread is on.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealProbe;

pub fn hwnd(h: Hwnd) -> HWND {
    HWND(h as *mut core::ffi::c_void)
}

pub fn class_of(h: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(h, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn pid_of(h: Hwnd) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd(h), Some(&mut pid)) };
    pid
}

pub fn foreground() -> Option<Hwnd> {
    let h = unsafe { GetForegroundWindow() };
    (!h.is_invalid()).then_some(h.0 as Hwnd)
}

pub fn rect_of(h: HWND) -> Rect {
    let mut r = RECT::default();
    if unsafe { GetWindowRect(h, &mut r) }.is_err() {
        return Rect::default();
    }
    Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    }
}

/// Whether the window is its own Alt-Tab root: walk from its root owner through each last
/// active popup until one is visible, and see whether the walk ends at the window itself.
fn alt_tab_root(h: HWND) -> bool {
    let mut walk = HWND::default();
    let mut next = unsafe { GetAncestor(h, GA_ROOTOWNER) };
    // A chain of popups is short; the bound only keeps a strange one from looping.
    for _ in 0..64 {
        if next == walk {
            break;
        }
        walk = next;
        next = unsafe { GetLastActivePopup(walk) };
        if unsafe { IsWindowVisible(next) }.as_bool() {
            break;
        }
    }
    walk == h
}

impl RealProbe {
    pub fn facts(h: Hwnd) -> Option<WindowFacts> {
        let w = hwnd(h);
        if !unsafe { IsWindow(Some(w)) }.as_bool() {
            return None;
        }
        let owner = unsafe { GetWindow(w, GW_OWNER) }
            .map(|o| o.0 as Hwnd)
            .unwrap_or(0);
        Some(WindowFacts {
            class: class_of(w),
            pid: pid_of(h),
            style: unsafe { GetWindowLongPtrW(w, GWL_STYLE) } as u32,
            ex_style: unsafe { GetWindowLongPtrW(w, GWL_EXSTYLE) } as u32,
            visible: unsafe { IsWindowVisible(w) }.as_bool(),
            root: unsafe { GetAncestor(w, GA_ROOT) } == w,
            owner,
            alt_tab_root: alt_tab_root(w),
            rect: rect_of(w),
            iconic: unsafe { IsIconic(w) }.as_bool(),
            zoomed: unsafe { IsZoomed(w) }.as_bool(),
        })
    }
}

impl Probe for RealProbe {
    fn window(&self, h: Hwnd) -> Option<WindowFacts> {
        RealProbe::facts(h)
    }

    fn cloaked(&self, h: Hwnd) -> Option<u32> {
        let mut cloaked = 0u32;
        unsafe {
            DwmGetWindowAttribute(
                hwnd(h),
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut core::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
        }
        .ok()
        .map(|_| cloaked)
    }

    fn process(&self, pid: u32) -> Result<ProcessFacts, Closed> {
        super::process::facts(pid)
    }

    fn uwp_child_pid(&self, frame: Hwnd) -> Option<u32> {
        let class: Vec<u16> = "Windows.UI.Core.CoreWindow"
            .encode_utf16()
            .chain([0])
            .collect();
        let child = unsafe {
            FindWindowExW(
                Some(hwnd(frame)),
                None,
                PCWSTR(class.as_ptr()),
                PCWSTR::null(),
            )
        }
        .ok()?;
        Some(pid_of(child.0 as Hwnd)).filter(|&p| p != 0)
    }

    fn title(&self, h: Hwnd) -> Option<String> {
        let mut buf = [0u16; 512];
        let n = unsafe { GetWindowTextW(hwnd(h), &mut buf) };
        (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
    }

    fn monitors(&self) -> Vec<super::monitors::Monitor> {
        super::monitors::enumerate()
    }

    fn top_level(&self) -> Vec<Hwnd> {
        top_level()
    }

    fn foreground(&self) -> Option<Hwnd> {
        foreground()
    }

    fn notification_state(&self) -> Option<i32> {
        super::game::notification_state()
    }

    fn input_desktop_ours(&self) -> bool {
        input_desktop_ours()
    }

    fn remote_session(&self) -> bool {
        unsafe { GetSystemMetrics(SM_REMOTESESSION) != 0 }
    }

    fn description(&self, path: &str) -> Option<String> {
        super::process::description(path)
    }
}

fn desktop_name(desk: HDESK) -> Option<String> {
    let mut buf = [0u16; 128];
    let mut needed = 0u32;
    unsafe {
        GetUserObjectInformationW(
            HANDLE(desk.0),
            UOI_NAME,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            (buf.len() * 2) as u32,
            Some(&mut needed),
        )
    }
    .ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

/// Whether the desktop taking input is this thread's. The secure desktop that UAC and the lock
/// screen use can't be opened at all, which reads as not ours.
pub fn input_desktop_ours() -> bool {
    let Ok(input) =
        (unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) })
    else {
        return false;
    };
    let theirs = desktop_name(input);
    unsafe {
        let _ = CloseDesktop(input);
    }
    let ours = unsafe { GetThreadDesktop(GetCurrentThreadId()) }
        .ok()
        .and_then(desktop_name);
    theirs.is_some() && theirs == ours
}

unsafe extern "system" fn collect(h: HWND, lparam: LPARAM) -> BOOL {
    let list = unsafe { &mut *(lparam.0 as *mut Vec<Hwnd>) };
    list.push(h.0 as Hwnd);
    BOOL(1)
}

/// Every top-level window on this thread's desktop, in z-order. Only on enable, settle end and
/// when the panel opens or asks (docs/nook-wm.md, "ENUMWINDOWS").
pub fn top_level() -> Vec<Hwnd> {
    let mut list: Vec<Hwnd> = Vec::with_capacity(256);
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    list
}
