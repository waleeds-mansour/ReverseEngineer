// What shuts the desk without you asking (desk.rs): Windows locking, the session disconnecting or
// logging off, and the PC going to sleep. A hidden window of its own hears them (session changes
// through WTSRegisterSessionNotification, sleep through the WM_POWERBROADCAST every top-level
// window gets) on a thread of its own, from the first unlock until the app quits, and each one
// drops the desk's secret at once and tells Hearth. It is started before Windows Hello is asked,
// so a lock while its prompt is up wins too: the unlock finds the desk's fence moved and installs
// nothing. The window is never shown and takes no input. Away from Windows there is none.

use tauri::AppHandle;

#[cfg(windows)]
pub fn start(app: &AppHandle) {
    use std::sync::OnceLock;
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("nook-desk-watch".into())
        .spawn(move || {
            if let Err(e) = os::run(app) {
                log::warn!("The desk can't hear Windows lock: {e}");
            }
        });
    if let Err(e) = spawned {
        log::warn!("The desk can't hear Windows lock: {e}");
    }
}

#[cfg(not(windows))]
pub fn start(_app: &AppHandle) {}

#[cfg(windows)]
mod os {
    use std::cell::RefCell;
    use std::panic::{self, AssertUnwindSafe};
    use tauri::AppHandle;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::WTSRegisterSessionNotification;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassExW,
        TranslateMessage, MSG, PBT_APMSUSPEND, WINDOW_EX_STYLE, WM_POWERBROADCAST,
        WM_WTSSESSION_CHANGE, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_POPUP,
    };

    /// WTSRegisterSessionNotification's "this session only".
    const NOTIFY_FOR_THIS_SESSION: u32 = 0;
    /// The session changes that end a sitting: the console or a remote connection going away,
    /// logging off, and locking (WTS_CONSOLE_DISCONNECT, WTS_REMOTE_DISCONNECT,
    /// WTS_SESSION_LOGOFF, WTS_SESSION_LOCK).
    const ENDS_SITTING: [usize; 4] = [0x2, 0x4, 0x6, 0x7];

    thread_local! {
        static APP: RefCell<Option<AppHandle>> = const { RefCell::new(None) };
    }

    /// Whether a window message ends the sitting.
    pub(super) fn ends_sitting(msg: u32, wparam: usize) -> bool {
        (msg == WM_WTSSESSION_CHANGE && ENDS_SITTING.contains(&wparam))
            || (msg == WM_POWERBROADCAST && wparam == PBT_APMSUSPEND as usize)
    }

    unsafe extern "system" fn wndproc(h: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        // Nothing may unwind into Windows: a panic here is caught and the message passed on.
        let _ = panic::catch_unwind(AssertUnwindSafe(|| {
            if ends_sitting(msg, wp.0) {
                APP.with(|a| {
                    if let Some(app) = a.borrow().as_ref() {
                        super::super::lock(app);
                    }
                });
            }
        }));
        unsafe { DefWindowProcW(h, msg, wp, lp) }
    }

    pub(super) fn run(app: AppHandle) -> windows::core::Result<()> {
        APP.with(|a| *a.borrow_mut() = Some(app));
        let instance = unsafe { GetModuleHandleW(None) }?;
        let class = w!("NookDeskWatch");
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(wndproc),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        unsafe { RegisterClassExW(&wc) };
        // Top-level, not message-only: only top-level windows get WM_POWERBROADCAST.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0),
                class,
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance.into()),
                None,
            )
        }?;
        unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) }?;
        let mut msg = MSG::default();
        while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        Ok(())
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::os::ends_sitting;
    use windows::Win32::UI::WindowsAndMessaging::{
        PBT_APMRESUMEAUTOMATIC, PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE,
    };

    #[test]
    fn locking_logging_off_disconnecting_and_sleeping_end_the_sitting() {
        for wts in [0x2, 0x4, 0x6, 0x7] {
            assert!(ends_sitting(WM_WTSSESSION_CHANGE, wts), "{wts}");
        }
        assert!(ends_sitting(WM_POWERBROADCAST, PBT_APMSUSPEND as usize));
    }

    #[test]
    fn unlocking_connecting_and_waking_leave_it_alone() {
        // WTS_CONSOLE_CONNECT, WTS_REMOTE_CONNECT, WTS_SESSION_LOGON, WTS_SESSION_UNLOCK.
        for wts in [0x1, 0x3, 0x5, 0x8] {
            assert!(!ends_sitting(WM_WTSSESSION_CHANGE, wts), "{wts}");
        }
        assert!(!ends_sitting(
            WM_POWERBROADCAST,
            PBT_APMRESUMEAUTOMATIC as usize
        ));
        assert!(!ends_sitting(0x0010, 0x7));
    }
}
