// The desktop seam on Win32. Reads are local user32 calls that never send a message to the app,
// so a hung app can't stall them; writes are asynchronous for the same reason. It acts on the
// desktop of the calling thread, which is how the tests keep to a private desktop of their own.
//
// The marker is a window property under one global atom, the way PowerToys FancyZones remembers
// the windows it placed (written anew here, no code taken).

use super::{check, Desktop, DesktopError, Mode};
use crate::objects::Signals;
use crate::placement::{Hwnd, Placement, Point, Rect};
use std::ffi::c_void;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, FILETIME, HANDLE, HWND, LPARAM, POINT, RECT, STILL_ACTIVE,
};
use windows::Win32::Graphics::Dwm::{
    DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_TRANSITIONS_FORCEDISABLED,
};
use windows::Win32::System::DataExchange::{GlobalAddAtomW, GlobalFindAtomW};
use windows::Win32::System::StationsAndDesktops::{EnumDesktopWindows, GetThreadDesktop};
use windows::Win32::System::Threading::{
    GetCurrentThreadId, GetExitCodeProcess, GetProcessTimes, OpenProcess,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{SHAppBarMessage, ABM_REMOVE, APPBARDATA};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetPropW, GetWindowPlacement, GetWindowThreadProcessId, IsWindow,
    IsWindowVisible, RemovePropW, SetPropW, SetWindowPlacement, ShowWindowAsync, SW_SHOWNOACTIVATE,
    WINDOWPLACEMENT, WINDOWPLACEMENT_FLAGS,
};

const MARKER_NAME: PCWSTR = windows::core::w!("Nook.State");

/// The marker's atom once this process has added it. Adding it again would only bump its
/// reference count, so it is added once and kept for the life of the process.
static MARKER_ATOM: AtomicU16 = AtomicU16::new(0);

fn added_atom() -> Option<u16> {
    let atom = MARKER_ATOM.load(Ordering::Relaxed);
    if atom != 0 {
        return Some(atom);
    }
    let atom = unsafe { GlobalAddAtomW(MARKER_NAME) };
    (atom != 0).then(|| {
        MARKER_ATOM.store(atom, Ordering::Relaxed);
        atom
    })
}

/// The marker's atom if any process ever added it this logon. Without it no window can carry
/// the marker, so a sweep can skip enumerating windows at all.
fn found_atom() -> Option<u16> {
    let atom = MARKER_ATOM.load(Ordering::Relaxed);
    if atom != 0 {
        return Some(atom);
    }
    let atom = unsafe { GlobalFindAtomW(MARKER_NAME) };
    (atom != 0).then_some(atom)
}

fn int_atom(atom: u16) -> PCWSTR {
    // MAKEINTATOM: the property name is the atom itself.
    PCWSTR(atom as usize as *const u16)
}

fn hwnd(h: Hwnd) -> HWND {
    HWND(h.0 as *mut c_void)
}

pub struct RealDesktop {
    mode: Mode,
    signals: Option<Arc<dyn Signals>>,
}

impl RealDesktop {
    /// The panel's view: reads only.
    pub fn observing() -> RealDesktop {
        RealDesktop {
            mode: Mode::Observing,
            signals: None,
        }
    }

    /// The window manager's view, stopped once `signals` revoke `epoch`.
    pub fn managing(signals: Arc<dyn Signals>, epoch: u64) -> RealDesktop {
        RealDesktop {
            mode: Mode::Managing { epoch },
            signals: Some(signals),
        }
    }

    /// A restorer's view.
    pub fn restoring() -> RealDesktop {
        RealDesktop {
            mode: Mode::Restoring,
            signals: None,
        }
    }

    fn allowed(&self) -> Result<(), DesktopError> {
        // A window manager without signals can't be stopped, so it may not write at all.
        let signals = self.signals.as_ref();
        check(&self.mode, |epoch| {
            signals.is_none_or(|s| s.is_revoked(epoch))
        })
    }

    /// The check right before a call, with everything the call needs already built.
    fn gate(&self, h: Hwnd) -> Result<HWND, DesktopError> {
        self.allowed()?;
        Ok(hwnd(h))
    }

    /// The check once more after the call. A window manager revoked while the call ran hears it
    /// now rather than at its next write, and doesn't count this write as its own; the restorer's
    /// later passes put that window right again (see desktop.rs).
    fn landed(&self, result: Result<(), DesktopError>) -> Result<(), DesktopError> {
        self.allowed()?;
        result
    }

    fn failed(&self, h: Hwnd, e: windows::core::Error) -> DesktopError {
        if !self.is_window(h) {
            return DesktopError::Gone;
        }
        match (e.code().0 as u32) & 0xffff {
            code if code == ERROR_ACCESS_DENIED.0 => DesktopError::Denied,
            code => DesktopError::Os(code),
        }
    }
}

fn to_placement(wp: &WINDOWPLACEMENT) -> Placement {
    let point = |p: POINT| Point { x: p.x, y: p.y };
    let r = wp.rcNormalPosition;
    Placement {
        flags: wp.flags.0,
        show_cmd: wp.showCmd,
        min_position: point(wp.ptMinPosition),
        max_position: point(wp.ptMaxPosition),
        normal_position: Rect::new(r.left, r.top, r.right, r.bottom),
    }
}

fn from_placement(p: &Placement) -> WINDOWPLACEMENT {
    let point = |p: Point| POINT { x: p.x, y: p.y };
    let r = p.normal_position;
    WINDOWPLACEMENT {
        length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
        flags: WINDOWPLACEMENT_FLAGS(p.flags),
        showCmd: p.show_cmd,
        ptMinPosition: point(p.min_position),
        ptMaxPosition: point(p.max_position),
        rcNormalPosition: RECT {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
        },
    }
}

unsafe extern "system" fn collect_marked(h: HWND, lparam: LPARAM) -> BOOL {
    // Runs inside EnumDesktopWindows, where an unwinding panic would abort the process; the body is
    // two calls and a push, none of which panics.
    let found = unsafe { &mut *(lparam.0 as *mut (u16, Vec<(Hwnd, u32)>)) };
    let bits = unsafe { GetPropW(h, int_atom(found.0)) };
    if !bits.0.is_null() {
        found.1.push((Hwnd(h.0 as isize), bits.0 as usize as u32));
    }
    BOOL(1)
}

impl Desktop for RealDesktop {
    fn mode(&self) -> Mode {
        self.mode
    }

    fn is_window(&self, h: Hwnd) -> bool {
        unsafe { IsWindow(Some(hwnd(h))) }.as_bool()
    }

    fn window_pid(&self, h: Hwnd) -> Option<u32> {
        let mut pid = 0u32;
        let thread = unsafe { GetWindowThreadProcessId(hwnd(h), Some(&mut pid)) };
        (thread != 0 && pid != 0).then_some(pid)
    }

    fn process_start(&self, pid: u32) -> Option<u64> {
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut times = [FILETIME::default(); 4];
        let [created, exited, kernel, user] = &mut times;
        let ok = unsafe { GetProcessTimes(process, created, exited, kernel, user) }.is_ok();
        // A process that ended still opens while anyone holds a handle to it (the guard holds
        // Hearth's), so only a running one counts; otherwise a dead writer would look alive.
        let mut code = 0u32;
        let running = unsafe { GetExitCodeProcess(process, &mut code) }.is_ok()
            && code == STILL_ACTIVE.0 as u32;
        unsafe {
            let _ = CloseHandle(process);
        }
        let created = times[0];
        (ok && running)
            .then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
    }

    fn class_name(&self, h: Hwnd) -> Option<String> {
        let mut buf = [0u16; 256];
        let n = unsafe { GetClassNameW(hwnd(h), &mut buf) };
        (n > 0).then(|| String::from_utf16_lossy(&buf[..n as usize]))
    }

    fn placement(&self, h: Hwnd) -> Option<Placement> {
        let mut wp = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        unsafe { GetWindowPlacement(hwnd(h), &mut wp) }.ok()?;
        Some(to_placement(&wp))
    }

    fn is_visible(&self, h: Hwnd) -> bool {
        unsafe { IsWindowVisible(hwnd(h)) }.as_bool()
    }

    fn marker(&self, h: Hwnd) -> Option<u32> {
        let atom = found_atom()?;
        let bits = unsafe { GetPropW(hwnd(h), int_atom(atom)) };
        (!bits.0.is_null()).then_some(bits.0 as usize as u32)
    }

    fn marked(&self) -> Vec<(Hwnd, u32)> {
        let Some(atom) = found_atom() else {
            return Vec::new();
        };
        // The calling thread's own desktop, named outright rather than left to EnumWindows, so a
        // sweep never reaches past the desktop its caller is on.
        let Ok(desktop) = (unsafe { GetThreadDesktop(GetCurrentThreadId()) }) else {
            return Vec::new();
        };
        let mut found: (u16, Vec<(Hwnd, u32)>) = (atom, Vec::new());
        let lparam = LPARAM(&mut found as *mut _ as isize);
        unsafe {
            let _ = EnumDesktopWindows(Some(desktop), Some(collect_marked), lparam);
        }
        found.1
    }

    fn set_placement(&self, h: Hwnd, placement: &Placement) -> Result<(), DesktopError> {
        let wp = from_placement(placement);
        let target = self.gate(h)?;
        let result = unsafe { SetWindowPlacement(target, &wp) };
        self.landed(result.map_err(|e| self.failed(h, e)))
    }

    fn show_no_activate(&self, h: Hwnd) -> Result<(), DesktopError> {
        let target = self.gate(h)?;
        // The return value says whether the window was visible before, not whether this worked.
        unsafe {
            let _ = ShowWindowAsync(target, SW_SHOWNOACTIVATE);
        }
        self.landed(Ok(()))
    }

    fn uncloak(&self, h: Hwnd) -> Result<(), DesktopError> {
        self.gate(h)?;
        // Nook cloaks nothing until P6, and then only on Windows builds whose COM layout is
        // verified; until that code exists there is nothing journaled as cloaked to undo.
        Err(DesktopError::Unsupported)
    }

    fn set_marker(&self, h: Hwnd, bits: u32) -> Result<(), DesktopError> {
        let atom = added_atom().ok_or(DesktopError::Os(0))?;
        let data = HANDLE(bits as usize as *mut c_void);
        let target = self.gate(h)?;
        let result = unsafe { SetPropW(target, int_atom(atom), Some(data)) };
        self.landed(result.map_err(|e| self.failed(h, e)))
    }

    fn remove_marker(&self, h: Hwnd) -> Result<(), DesktopError> {
        let target = self.gate(h)?;
        if let Some(atom) = found_atom() {
            // No property to remove is the state we want, so it is not an error.
            unsafe {
                let _ = RemovePropW(target, int_atom(atom));
            }
        }
        self.landed(Ok(()))
    }

    fn set_border_color(&self, h: Hwnd, color: u32) -> Result<(), DesktopError> {
        let value = &color as *const u32 as *const c_void;
        let target = self.gate(h)?;
        let result = unsafe { DwmSetWindowAttribute(target, DWMWA_BORDER_COLOR, value, 4) };
        self.landed(result.map_err(|e| self.failed(h, e)))
    }

    fn set_transitions_disabled(&self, h: Hwnd, disabled: bool) -> Result<(), DesktopError> {
        let flag = BOOL::from(disabled);
        let value = &flag as *const BOOL as *const c_void;
        let size = std::mem::size_of::<BOOL>() as u32;
        let target = self.gate(h)?;
        let attribute = DWMWA_TRANSITIONS_FORCEDISABLED;
        let result = unsafe { DwmSetWindowAttribute(target, attribute, value, size) };
        self.landed(result.map_err(|e| self.failed(h, e)))
    }

    fn remove_appbar(&self, h: Hwnd) -> Result<(), DesktopError> {
        let target = self.gate(h)?;
        let mut data = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: target,
            ..Default::default()
        };
        // ABM_REMOVE always reports success; an AppBar that is already gone is fine.
        unsafe {
            SHAppBarMessage(ABM_REMOVE, &mut data);
        }
        self.landed(Ok(()))
    }
}
