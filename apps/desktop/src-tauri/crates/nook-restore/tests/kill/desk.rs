// A private desktop for the kill tests, and the programs started on it. The desktop comes from
// CreateDesktopW and is never switched to, so nothing on it is ever shown. Programs join it
// through STARTUPINFOW.lpDesktop (and the guard inherits it from the host that starts it); the
// harness's own reads run on a thread that joined it with SetThreadDesktop and checked that it
// did. Nothing here makes or touches a window on the owner's desktop. Every program starts
// suspended and joins a kill-on-close job before it runs a single instruction.

use crate::jobs::{self, Job};
use crate::procs::Proc;
use nook_restore::guard::spawn::command_line;
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, GENERIC_ALL, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, CreateDesktopW, GetProcessWindowStation, GetThreadDesktop, SetThreadDesktop,
    DESKTOP_CONTROL_FLAGS, HDESK,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetCurrentThreadId, ResumeThread, TerminateProcess,
    BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW, CREATE_SUSPENDED, PROCESS_INFORMATION,
    STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

#[allow(dead_code)]
#[path = "../../examples/shared/desktop.rs"]
mod names;

pub struct PrivateDesktop {
    handle: HDESK,
    /// "WinSta0\NookTest-...", for lpDesktop.
    full: String,
    job: Job,
}

// The handle is only used to join the desktop and to close it.
unsafe impl Send for PrivateDesktop {}
unsafe impl Sync for PrivateDesktop {}

impl PrivateDesktop {
    pub fn create(label: &str, job: Job) -> PrivateDesktop {
        let name = format!("{}{}-{label}", names::PREFIX, std::process::id());
        let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
        let flags = DESKTOP_CONTROL_FLAGS(0);
        let handle = unsafe {
            CreateDesktopW(
                PCWSTR(wide.as_ptr()),
                None,
                None,
                flags,
                GENERIC_ALL.0,
                None,
            )
        }
        .expect("a private desktop");
        let station = unsafe { GetProcessWindowStation() }.expect("this process's window station");
        let station = names::name_of(HANDLE(station.0));
        assert!(!station.is_empty(), "the window station has a name");
        PrivateDesktop {
            handle,
            full: format!("{station}\\{name}"),
            job,
        }
    }

    /// Runs `body` on a new thread joined to this desktop, per-monitor-v2 aware like Nook, and
    /// refuses to run it at all unless the join worked.
    pub fn on<R: Send + 'static>(&self, body: impl FnOnce() -> R + Send + 'static) -> R {
        let raw = self.handle.0 as usize;
        std::thread::spawn(move || {
            let desk = HDESK(raw as *mut _);
            unsafe { SetThreadDesktop(desk) }.expect("the thread joins the private desktop");
            let now_on = unsafe { GetThreadDesktop(GetCurrentThreadId()) }.unwrap();
            assert_eq!(
                now_on, desk,
                "still on the owner's desktop: stop before any read"
            );
            assert!(names::this_thread().starts_with(names::PREFIX));
            unsafe {
                let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            body()
        })
        .join()
        .expect("the private-desktop thread")
    }

    /// Starts `exe` on this desktop, below normal priority, with no window, and its output
    /// coming back line by line.
    pub fn spawn(&self, exe: &Path, args: &[String]) -> Child {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        let mut line = command_line(exe, &args);
        let app: Vec<u16> = exe.as_os_str().encode_utf16_lossy();
        let mut desktop: Vec<u16> = self.full.encode_utf16().chain([0]).collect();
        let inherit = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            bInheritHandle: true.into(),
            ..Default::default()
        };
        let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
        unsafe { CreatePipe(&mut read, &mut write, Some(&inherit), 0) }.expect("a pipe");
        // Only the child's end is inherited.
        unsafe { SetHandleInformation(read, HANDLE_FLAG_INHERIT.0, HANDLE_FLAGS(0)) }.unwrap();
        let info = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop.as_mut_ptr()),
            dwFlags: STARTF_USESTDHANDLES,
            hStdOutput: write,
            hStdError: write,
            ..Default::default()
        };
        let mut started = PROCESS_INFORMATION::default();
        let flags = CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS | CREATE_SUSPENDED;
        let result = unsafe {
            CreateProcessW(
                PCWSTR(app.as_ptr()),
                Some(PWSTR(line.as_mut_ptr())),
                None,
                None,
                true,
                flags,
                None,
                PCWSTR::null(),
                &info,
                &mut started,
            )
        };
        unsafe {
            let _ = CloseHandle(write);
        }
        result.unwrap_or_else(|e| panic!("can't start {}: {e}", exe.display()));
        if let Err(e) = jobs::assign(self.job, started.hProcess) {
            unsafe {
                let _ = TerminateProcess(started.hProcess, 1);
            }
            panic!("{} can't join the test's job: {e}", exe.display());
        }
        unsafe {
            ResumeThread(started.hThread);
            let _ = CloseHandle(started.hThread);
        }
        let log = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = channel();
        let file = unsafe { File::from_raw_handle(read.0) };
        let name = exe
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let kept = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                kept.lock().unwrap().push(format!("{name}: {line}"));
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Child {
            process: Proc::from_handle(started.dwProcessId, started.hProcess),
            lines: rx,
            log,
        }
    }
}

impl Drop for PrivateDesktop {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseDesktop(self.handle);
        }
    }
}

trait Wide {
    fn encode_utf16_lossy(&self) -> Vec<u16>;
}

impl Wide for std::ffi::OsStr {
    fn encode_utf16_lossy(&self) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        self.encode_wide().chain([0]).collect()
    }
}

/// A program on the private desktop and the lines it prints.
pub struct Child {
    pub process: Proc,
    lines: Receiver<String>,
    pub log: Arc<Mutex<Vec<String>>>,
}

impl Child {
    /// The next line that `want` accepts, skipping others; None if the program ends or goes
    /// quiet for `timeout` first.
    pub fn wait_for(&self, want: impl Fn(&str) -> bool, timeout: Duration) -> Option<String> {
        let until = Instant::now() + timeout;
        loop {
            let left = until.checked_duration_since(Instant::now())?;
            let line = self.lines.recv_timeout(left).ok()?;
            if want(&line) {
                return Some(line);
            }
        }
    }

    pub fn log(&self) -> Vec<String> {
        self.log.lock().unwrap().clone()
    }
}
