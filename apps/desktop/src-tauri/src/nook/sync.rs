// The waiting Nook's threads do (docs/nook-wm.md, "THREADS IN hearth.exe"): kernel events, the
// high-resolution waitable timer the trailing flush uses, and one wait that also wakes for window
// messages, which is how out-of-context WinEvent callbacks arrive. Every thread blocks here with
// no timeout when it has nothing to do, so an idle Nook wakes nobody. timeBeginPeriod is never
// called; the timer is high resolution by itself.

use std::io;
use std::time::Duration;
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, SetLastError, ERROR_ALREADY_EXISTS, ERROR_SUCCESS, HANDLE,
    WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Threading::{
    CancelWaitableTimer, CreateEventW, CreateWaitableTimerExW, SetEvent, SetWaitableTimer,
    CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE, TIMER_ALL_ACCESS,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, TranslateMessage, MSG,
    MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT, WM_QUIT,
};

/// A kernel handle that closes when dropped. Handles may be used from any thread.
pub struct Handle(HANDLE);

unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Handle {
    pub fn raw(&self) -> HANDLE {
        self.0
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// An auto-reset event: one wait wakes for each set.
pub fn event(name: Option<&str>) -> io::Result<Handle> {
    let name = name.map(HSTRING::from);
    let ptr = name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
    unsafe { CreateEventW(None, false, false, ptr) }
        .map(Handle)
        .map_err(io::Error::other)
}

/// A named auto-reset event that this call made. One that already existed was made by another
/// process, or is still held from an earlier run, and isn't Nook's to wait on: an error.
pub fn own_event(name: &str) -> io::Result<Handle> {
    unsafe { SetLastError(ERROR_SUCCESS) };
    let made = event(Some(name))?;
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("the event {name} already exists"),
        ));
    }
    Ok(made)
}

/// Opens an event another process made, to set it. The perf script does this from PowerShell;
/// the tests do it here.
#[cfg(test)]
pub fn open_event(name: &str) -> io::Result<Handle> {
    use windows::Win32::System::Threading::{
        OpenEventW, EVENT_MODIFY_STATE, SYNCHRONIZATION_SYNCHRONIZE,
    };
    let name = HSTRING::from(name);
    let access = EVENT_MODIFY_STATE | SYNCHRONIZATION_SYNCHRONIZE;
    unsafe { OpenEventW(access, false, PCWSTR(name.as_ptr())) }
        .map(Handle)
        .map_err(io::Error::other)
}

pub fn set(event: &Handle) {
    unsafe {
        let _ = SetEvent(event.0);
    }
}

/// A one-shot high-resolution timer.
pub struct Timer {
    handle: Handle,
    pub armed: bool,
}

impl Timer {
    pub fn new() -> io::Result<Timer> {
        let h = unsafe {
            CreateWaitableTimerExW(
                None,
                PCWSTR::null(),
                CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                TIMER_ALL_ACCESS.0,
            )
        }
        .map_err(io::Error::other)?;
        Ok(Timer {
            handle: Handle(h),
            armed: false,
        })
    }

    pub fn raw(&self) -> HANDLE {
        self.handle.raw()
    }

    /// Signals once, `after` from now. Arming again moves it.
    pub fn arm(&mut self, after: Duration) {
        // Negative means relative, in 100 ns units; at least one unit, so it is never absolute.
        let due = -(after.as_nanos() as i64 / 100).max(1);
        let ok = unsafe { SetWaitableTimer(self.handle.raw(), &due, 0, None, None, false) };
        self.armed = ok.is_ok();
    }

    pub fn cancel(&mut self) {
        if self.armed {
            unsafe {
                let _ = CancelWaitableTimer(self.handle.raw());
            }
            self.armed = false;
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Woke {
    /// The handle at this index was signalled.
    Handle(usize),
    /// A message, or a WinEvent callback, is waiting.
    Message,
    Timeout,
    Failed,
}

/// Waits for one of `handles`, a message, or the timeout (None: forever).
pub fn wait(handles: &[HANDLE], timeout: Option<Duration>) -> Woke {
    let ms = timeout.map_or(INFINITE, |t| {
        t.as_millis().min(u128::from(INFINITE - 1)) as u32
    });
    let r =
        unsafe { MsgWaitForMultipleObjectsEx(Some(handles), ms, QS_ALLINPUT, MWMO_INPUTAVAILABLE) };
    let n = handles.len() as u32;
    // The result is WAIT_OBJECT_0 plus the handle's index, or plus the count for a message.
    let i = r.0.wrapping_sub(WAIT_OBJECT_0.0);
    if r == WAIT_TIMEOUT {
        Woke::Timeout
    } else if r == WAIT_FAILED {
        Woke::Failed
    } else if i < n {
        Woke::Handle(i as usize)
    } else if i == n {
        Woke::Message
    } else {
        Woke::Failed
    }
}

/// Dispatches every waiting message; WinEvent callbacks run inside PeekMessageW. False once
/// WM_QUIT arrives.
pub fn pump() -> bool {
    let mut msg = MSG::default();
    while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
        if msg.message == WM_QUIT {
            return false;
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn an_event_wakes_the_wait_once() {
        let e = event(None).unwrap();
        set(&e);
        assert_eq!(wait(&[e.raw()], Some(Duration::ZERO)), Woke::Handle(0));
        assert_eq!(wait(&[e.raw()], Some(Duration::ZERO)), Woke::Timeout);
    }

    #[test]
    fn the_timer_fires_after_its_delay_and_not_before() {
        let mut t = Timer::new().unwrap();
        let start = Instant::now();
        t.arm(Duration::from_millis(16));
        assert!(t.armed);
        assert_eq!(
            wait(&[t.raw()], Some(Duration::from_secs(2))),
            Woke::Handle(0)
        );
        let took = start.elapsed();
        assert!(took >= Duration::from_millis(15), "{took:?}");
        t.arm(Duration::from_millis(50));
        t.cancel();
        assert_eq!(
            wait(&[t.raw()], Some(Duration::from_millis(80))),
            Woke::Timeout
        );
    }

    #[test]
    fn a_named_event_someone_else_made_first_is_refused() {
        let name = format!(r"Local\NookTest.Own.{}", std::process::id());
        let first = own_event(&name).expect("made");
        assert!(
            matches!(own_event(&name), Err(e) if e.kind() == io::ErrorKind::AlreadyExists),
            "it already exists"
        );
        drop(first);
        assert!(own_event(&name).is_ok(), "gone with its last handle");
    }
}
