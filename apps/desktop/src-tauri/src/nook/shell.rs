// nook-shell (docs/nook-wm.md, "THREADS IN hearth.exe"): a hidden top-level window that hears what
// Windows broadcasts about displays, work areas, devices, power, sessions, Explorer restarting and
// logging off, and hands each to nook-wm. It is a real top-level window rather than a
// message-only one because broadcasts skip message-only windows; it is a popup tool window that
// is never shown, so it has no taskbar button and nothing on screen. Its window procedure is
// panic-free: a panic is caught there and reported as a signal, never unwound across Windows.

use super::perf::Counters;
use std::cell::RefCell;
use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::Arc;
use windows::core::{w, GUID, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Power::{
    RegisterPowerSettingNotification, UnregisterPowerSettingNotification, HPOWERNOTIFY,
    POWERBROADCAST_SETTING,
};
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
    GetMessageW, PostMessageW, PostQuitMessage, RegisterClassExW, RegisterWindowMessageW,
    TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, MSG, MSGFLT_ALLOW, PBT_APMRESUMEAUTOMATIC,
    PBT_POWERSETTINGCHANGE, SPI_SETCLIENTAREAANIMATION, SPI_SETHIGHCONTRAST, SPI_SETWORKAREA,
    WINDOW_EX_STYLE, WM_CLOSE, WM_DESTROY, WM_DEVICECHANGE, WM_DISPLAYCHANGE, WM_ENDSESSION,
    WM_POWERBROADCAST, WM_QUERYENDSESSION, WM_SETTINGCHANGE, WM_WTSSESSION_CHANGE, WNDCLASSEXW,
    WS_EX_TOOLWINDOW, WS_POPUP,
};

/// GUID_CONSOLE_DISPLAY_STATE: the console's display went off, on or dim.
const CONSOLE_DISPLAY_STATE: GUID = GUID::from_u128(0x6fe69556_704a_47a0_8f24_c28d936fda47);
const NOTIFY_FOR_THIS_SESSION: u32 = 0;
const DBT_DEVNODES_CHANGED: usize = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    DisplayChange,
    WorkArea,
    /// Light or dark, accent or high contrast.
    Theme,
    DevicesChanged,
    Resume,
    /// 0 off, 1 on, 2 dimmed.
    DisplayState(u32),
    /// A WTS_* code: lock, unlock, remote and console connects.
    Session(u32),
    TaskbarCreated,
    QueryEndSession,
    EndSession(bool),
    /// The window procedure caught a panic.
    Fault,
}

/// The running shell window, so another thread can close it.
#[derive(Default)]
pub struct Shell {
    hwnd: AtomicIsize,
    /// A stop asked for before the window existed is kept here, and run() closes the window as
    /// soon as it has made it.
    stopping: AtomicBool,
    pub counters: Arc<Counters>,
}

impl Shell {
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let h = self.hwnd.load(Ordering::SeqCst);
        if h != 0 {
            unsafe {
                let _ = PostMessageW(Some(HWND(h as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    }

    #[cfg(test)]
    pub fn hwnd(&self) -> isize {
        self.hwnd.load(Ordering::SeqCst)
    }
}

struct Here {
    sink: Box<dyn Fn(Signal)>,
    taskbar_created: u32,
    power: Option<HPOWERNOTIFY>,
    /// The display's last state. Registering for it sends the current one at once, which is
    /// not a change and mustn't start a settle.
    display: Option<u32>,
    counters: Arc<Counters>,
}

/// Whether a display-state notification is a change worth a signal.
fn display_changed(last: &mut Option<u32>, now: u32) -> bool {
    last.replace(now).is_some_and(|before| before != now)
}

thread_local! {
    static HERE: RefCell<Option<Here>> = const { RefCell::new(None) };
}

fn tell(signal: Signal) {
    HERE.with(|h| {
        if let Some(here) = h.borrow().as_ref() {
            (here.sink)(signal);
        }
    });
}

fn signal_for(msg: u32, wparam: WPARAM, lparam: LPARAM, taskbar_created: u32) -> Option<Signal> {
    match msg {
        WM_DISPLAYCHANGE => Some(Signal::DisplayChange),
        WM_SETTINGCHANGE if wparam.0 as u32 == SPI_SETWORKAREA.0 => Some(Signal::WorkArea),
        // Animations turned off or on, and high contrast: both change how the bar looks.
        WM_SETTINGCHANGE
            if [SPI_SETCLIENTAREAANIMATION.0, SPI_SETHIGHCONTRAST.0]
                .contains(&(wparam.0 as u32)) =>
        {
            Some(Signal::Theme)
        }
        WM_SETTINGCHANGE if lparam.0 != 0 => {
            let text = unsafe { PCWSTR(lparam.0 as *const u16).to_string() }.unwrap_or_default();
            matches!(text.as_str(), "ImmersiveColorSet" | "WindowsThemeElement")
                .then_some(Signal::Theme)
        }
        WM_DEVICECHANGE if wparam.0 == DBT_DEVNODES_CHANGED => Some(Signal::DevicesChanged),
        WM_POWERBROADCAST if wparam.0 as u32 == PBT_APMRESUMEAUTOMATIC => Some(Signal::Resume),
        WM_POWERBROADCAST if wparam.0 as u32 == PBT_POWERSETTINGCHANGE && lparam.0 != 0 => {
            let setting = unsafe { &*(lparam.0 as *const POWERBROADCAST_SETTING) };
            (setting.PowerSetting == CONSOLE_DISPLAY_STATE && setting.DataLength >= 4)
                .then(|| Signal::DisplayState(u32::from(setting.Data[0])))
        }
        WM_WTSSESSION_CHANGE => Some(Signal::Session(wparam.0 as u32)),
        WM_QUERYENDSESSION => Some(Signal::QueryEndSession),
        WM_ENDSESSION => Some(Signal::EndSession(wparam.0 != 0)),
        m if m != 0 && m == taskbar_created => Some(Signal::TaskbarCreated),
        _ => None,
    }
}

unsafe extern "system" fn wndproc(h: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let caught = panic::catch_unwind(AssertUnwindSafe(|| {
        let taskbar_created = HERE.with(|here| {
            here.borrow().as_ref().map(|x| {
                Counters::bump(&x.counters.messages);
                x.taskbar_created
            })
        });
        if let Some(signal) = signal_for(msg, wparam, lparam, taskbar_created.unwrap_or(0)) {
            let changed = match signal {
                Signal::DisplayState(now) => HERE.with(|here| {
                    here.borrow_mut()
                        .as_mut()
                        .is_some_and(|x| display_changed(&mut x.display, now))
                }),
                _ => true,
            };
            if changed {
                tell(signal);
            }
        }
        match msg {
            // Logging off may go ahead; Nook has nothing of its own to save while observing.
            WM_QUERYENDSESSION => Some(LRESULT(1)),
            WM_CLOSE => {
                unsafe {
                    let _ = DestroyWindow(h);
                }
                Some(LRESULT(0))
            }
            WM_DESTROY => {
                unsafe {
                    let _ = WTSUnRegisterSessionNotification(h);
                }
                HERE.with(|here| {
                    if let Some(p) = here.borrow_mut().as_mut().and_then(|x| x.power.take()) {
                        unsafe {
                            let _ = UnregisterPowerSettingNotification(p);
                        }
                    }
                });
                unsafe { PostQuitMessage(0) };
                Some(LRESULT(0))
            }
            _ => None,
        }
    }));
    match caught {
        Ok(Some(result)) => result,
        Ok(None) => unsafe { DefWindowProcW(h, msg, wparam, lparam) },
        Err(_) => {
            // Telling runs the app's sink, which mustn't unwind into Windows either.
            let _ = panic::catch_unwind(|| tell(Signal::Fault));
            unsafe { DefWindowProcW(h, msg, wparam, lparam) }
        }
    }
}

/// nook-shell's body: makes the window on this thread's desktop and pumps until it is closed.
pub fn run(shell: Arc<Shell>, sink: impl Fn(Signal) + 'static) -> windows::core::Result<()> {
    let _here = shell.counters.here();
    if shell.stopping.load(Ordering::SeqCst) {
        return Ok(());
    }
    let instance = unsafe { GetModuleHandleW(None) }?;
    let class = w!("NookShell");
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wndproc),
        hInstance: instance.into(),
        lpszClassName: class,
        ..Default::default()
    };
    // A second registration in the same process fails harmlessly with the class already there.
    unsafe { RegisterClassExW(&wc) };
    let taskbar_created = unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) };
    HERE.with(|h| {
        *h.borrow_mut() = Some(Here {
            sink: Box::new(sink),
            taskbar_created,
            power: None,
            display: None,
            counters: shell.counters.clone(),
        })
    });
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
    };
    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            HERE.with(|h| h.borrow_mut().take());
            return Err(e);
        }
    };
    unsafe {
        // An elevated Hearth still hears Explorer, which runs unelevated.
        if taskbar_created != 0 {
            let _ = ChangeWindowMessageFilterEx(hwnd, taskbar_created, MSGFLT_ALLOW, None);
        }
        let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        let power = RegisterPowerSettingNotification(
            HANDLE(hwnd.0),
            &CONSOLE_DISPLAY_STATE,
            DEVICE_NOTIFY_WINDOW_HANDLE,
        )
        .ok();
        HERE.with(|h| {
            if let Some(here) = h.borrow_mut().as_mut() {
                here.power = power;
            }
        });
    }
    shell.hwnd.store(hwnd.0 as isize, Ordering::SeqCst);
    // A stop that came while the window was being made found no window to close.
    if shell.stopping.load(Ordering::SeqCst) {
        unsafe {
            let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        Counters::bump(&shell.counters.wakeups);
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    shell.hwnd.store(0, Ordering::SeqCst);
    HERE.with(|h| h.borrow_mut().take());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broadcasts_become_signals() {
        let s = |m, w, l| signal_for(m, WPARAM(w), LPARAM(l), 0xC123);
        assert_eq!(s(WM_DISPLAYCHANGE, 0, 0), Some(Signal::DisplayChange));
        assert_eq!(
            s(WM_SETTINGCHANGE, SPI_SETWORKAREA.0 as usize, 0),
            Some(Signal::WorkArea)
        );
        let theme: Vec<u16> = "ImmersiveColorSet".encode_utf16().chain([0]).collect();
        assert_eq!(
            s(WM_SETTINGCHANGE, 0, theme.as_ptr() as isize),
            Some(Signal::Theme)
        );
        let other: Vec<u16> = "Environment".encode_utf16().chain([0]).collect();
        assert_eq!(s(WM_SETTINGCHANGE, 0, other.as_ptr() as isize), None);
        for spi in [SPI_SETCLIENTAREAANIMATION, SPI_SETHIGHCONTRAST] {
            assert_eq!(
                s(WM_SETTINGCHANGE, spi.0 as usize, 0),
                Some(Signal::Theme),
                "{spi:?}"
            );
        }
        assert_eq!(
            s(WM_DEVICECHANGE, DBT_DEVNODES_CHANGED, 0),
            Some(Signal::DevicesChanged)
        );
        assert_eq!(s(WM_DEVICECHANGE, 0x8000, 0), None);
        assert_eq!(
            s(WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC as usize, 0),
            Some(Signal::Resume)
        );
        assert_eq!(s(WM_WTSSESSION_CHANGE, 7, 0), Some(Signal::Session(7)));
        assert_eq!(s(WM_ENDSESSION, 1, 0), Some(Signal::EndSession(true)));
        assert_eq!(s(0xC123, 0, 0), Some(Signal::TaskbarCreated));
        assert_eq!(s(0x0400, 0, 0), None);
    }

    #[test]
    fn only_a_change_of_display_state_counts() {
        let mut last = None;
        assert!(
            !display_changed(&mut last, 1),
            "the value sent on registering"
        );
        assert!(!display_changed(&mut last, 1));
        assert!(display_changed(&mut last, 0), "off");
        assert!(display_changed(&mut last, 1), "on again");
    }
}
