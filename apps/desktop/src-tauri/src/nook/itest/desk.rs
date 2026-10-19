// A private desktop for Nook's window tests, and the programs started on it. The desktop comes
// from CreateDesktopW and is never switched to, so nothing on it is ever shown. Programs join it
// through STARTUPINFOW.lpDesktop; the test's own reads and hooks run on a thread that joined it
// with SetThreadDesktop and checked that it did. Every program starts suspended and joins a
// kill-on-close job before it runs, so none outlives its test. Adapted from nook-restore's
// tests/kill/desk.rs, which is Hearth's own.

use std::ffi::c_void;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, SetHandleInformation, GENERIC_ALL, HANDLE, HANDLE_FLAGS, HANDLE_FLAG_INHERIT,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, CreateDesktopW, GetProcessWindowStation, GetThreadDesktop,
    GetUserObjectInformationW, SetThreadDesktop, DESKTOP_CONTROL_FLAGS, HDESK, UOI_NAME,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetCurrentThreadId, ResumeThread, TerminateProcess,
    BELOW_NORMAL_PRIORITY_CLASS, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows::Win32::UI::HiDpi::{
    SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};

/// Every test desktop's name starts with this, and the window host refuses any other.
pub const PREFIX: &str = "NookTest-";

/// The name of a desktop or window station, such as "Default" or "WinSta0".
pub fn name_of(object: HANDLE) -> String {
    let mut buf = [0u16; 256];
    let size = std::mem::size_of_val(&buf) as u32;
    let got = unsafe {
        GetUserObjectInformationW(object, UOI_NAME, Some(buf.as_mut_ptr().cast()), size, None)
    };
    if got.is_err() {
        return String::new();
    }
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// The desktop the calling thread runs on.
pub fn this_thread() -> String {
    match unsafe { GetThreadDesktop(GetCurrentThreadId()) } {
        Ok(desk) => name_of(HANDLE(desk.0)),
        Err(_) => String::new(),
    }
}

pub struct PrivateDesktop {
    handle: HDESK,
    /// "WinSta0\NookTest-...", for lpDesktop.
    full: String,
    job: HANDLE,
}

// The handles are only used to join the desktop, to fill the job and to close both.
unsafe impl Send for PrivateDesktop {}
unsafe impl Sync for PrivateDesktop {}

impl PrivateDesktop {
    pub fn create(label: &str) -> PrivateDesktop {
        static N: AtomicU32 = AtomicU32::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let name = format!("{PREFIX}{}-{label}-{n}", std::process::id());
        let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
        let handle = unsafe {
            CreateDesktopW(
                PCWSTR(wide.as_ptr()),
                None,
                None,
                DESKTOP_CONTROL_FLAGS(0),
                GENERIC_ALL.0,
                None,
            )
        }
        .expect("a private desktop");
        let station = unsafe { GetProcessWindowStation() }.expect("this process's window station");
        let station = name_of(HANDLE(station.0));
        assert!(!station.is_empty(), "the window station has a name");
        let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.expect("a job object");
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of_val(&info) as u32;
        let ptr = &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void;
        unsafe { SetInformationJobObject(job, JobObjectExtendedLimitInformation, ptr, size) }
            .expect("the job kills its processes when the test ends");
        PrivateDesktop {
            handle,
            full: format!("{station}\\{name}"),
            job,
        }
    }

    /// Runs `body` on a new thread joined to this desktop, per-monitor-v2 aware like Hearth,
    /// and refuses to run it at all unless the join worked.
    pub fn on<R: Send + 'static>(&self, body: impl FnOnce() -> R + Send + 'static) -> R {
        self.thread(body)
            .join()
            .unwrap_or_else(|e| std::panic::resume_unwind(e))
    }

    /// The same, without waiting for it.
    pub fn thread<R: Send + 'static>(
        &self,
        body: impl FnOnce() -> R + Send + 'static,
    ) -> std::thread::JoinHandle<R> {
        let raw = self.handle.0 as usize;
        std::thread::spawn(move || {
            let desk = HDESK(raw as *mut _);
            unsafe { SetThreadDesktop(desk) }.expect("the thread joins the private desktop");
            let now_on = unsafe { GetThreadDesktop(GetCurrentThreadId()) }.unwrap();
            assert_eq!(
                now_on, desk,
                "still on the owner's desktop: stop before anything"
            );
            assert!(this_thread().starts_with(PREFIX));
            unsafe {
                let _ = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            }
            body()
        })
    }

    /// Starts `exe` on this desktop, below normal priority, with no console, in the job, with
    /// its output coming back line by line.
    pub fn spawn(&self, exe: &Path, args: &[&str], env: &[(&str, &str)]) -> Child {
        let mut cmd = quote(&exe.display().to_string());
        for a in args {
            cmd.push(' ');
            cmd.push_str(&quote(a));
        }
        let mut line: Vec<u16> = cmd.encode_utf16().chain([0]).collect();
        let app: Vec<u16> = exe.as_os_str().encode_wide_z();
        let mut desktop: Vec<u16> = self.full.encode_utf16().chain([0]).collect();
        let block = env_block(env);
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
        let flags = CREATE_NO_WINDOW
            | BELOW_NORMAL_PRIORITY_CLASS
            | CREATE_SUSPENDED
            | CREATE_UNICODE_ENVIRONMENT;
        let result = unsafe {
            CreateProcessW(
                PCWSTR(app.as_ptr()),
                Some(PWSTR(line.as_mut_ptr())),
                None,
                None,
                true,
                flags,
                Some(block.as_ptr() as *const c_void),
                PCWSTR::null(),
                &info,
                &mut started,
            )
        };
        unsafe {
            let _ = CloseHandle(write);
        }
        result.unwrap_or_else(|e| panic!("can't start {}: {e}", exe.display()));
        if let Err(e) = unsafe { AssignProcessToJobObject(self.job, started.hProcess) } {
            unsafe {
                let _ = TerminateProcess(started.hProcess, 1);
            }
            panic!("{} can't join the test's job: {e}", exe.display());
        }
        unsafe {
            ResumeThread(started.hThread);
            let _ = CloseHandle(started.hThread);
            let _ = CloseHandle(started.hProcess);
        }
        let (tx, rx) = channel();
        let file = unsafe { File::from_raw_handle(read.0) };
        std::thread::spawn(move || {
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        });
        Child {
            pid: started.dwProcessId,
            lines: rx,
        }
    }

    /// The bare name, "NookTest-...", as the desktop's own threads see it.
    pub fn name(&self) -> &str {
        self.full.rsplit('\\').next().unwrap_or_default()
    }

    /// CPU time of everything in the job so far.
    pub fn job_cpu(&self) -> Duration {
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let size = std::mem::size_of_val(&info) as u32;
        let ptr = &mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION as *mut c_void;
        unsafe {
            QueryInformationJobObject(
                Some(self.job),
                JobObjectBasicAccountingInformation,
                ptr,
                size,
                None,
            )
        }
        .expect("the job's accounting");
        let hundreds = info.TotalUserTime + info.TotalKernelTime;
        Duration::from_nanos(hundreds.max(0) as u64 * 100)
    }
}

impl Drop for PrivateDesktop {
    fn drop(&mut self) {
        unsafe {
            // Closing the job ends every program in it.
            let _ = CloseHandle(self.job);
            let _ = CloseDesktop(self.handle);
        }
    }
}

fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

/// This process's environment with `extra` added, as CreateProcessW wants it.
fn env_block(extra: &[(&str, &str)]) -> Vec<u16> {
    let mut vars: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| !extra.iter().any(|(e, _)| e.eq_ignore_ascii_case(k)))
        .collect();
    vars.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    // Windows wants the block sorted by name, ignoring case.
    vars.sort_by_key(|(k, _)| k.to_uppercase());
    let mut block: Vec<u16> = Vec::new();
    for (k, v) in vars {
        block.extend(format!("{k}={v}").encode_utf16());
        block.push(0);
    }
    block.push(0);
    block
}

trait Wide {
    fn encode_wide_z(&self) -> Vec<u16>;
}

impl Wide for std::ffi::OsStr {
    fn encode_wide_z(&self) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;
        self.encode_wide().chain([0]).collect()
    }
}

/// A program on the private desktop and the lines it prints.
pub struct Child {
    pub pid: u32,
    lines: Receiver<String>,
}

impl Child {
    /// A line already printed, without waiting.
    pub fn try_line(&self) -> Option<String> {
        self.lines.try_recv().ok()
    }

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
}
