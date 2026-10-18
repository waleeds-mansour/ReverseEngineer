// Starting the guard so that nothing which ends Hearth ends the guard too (docs/nook-wm.md,
// "Double spawn"). Hearth starts `nook-guard --launch`, which starts `nook-guard --watch` and
// exits at once, so the guard's parent is a process that no longer exists: taskkill /T and Task
// Manager's End task walk Hearth's tree and never reach it. Both starts ask to leave any job
// Hearth runs in, so closing that job doesn't take the guard with it; a job that forbids leaving
// keeps the guard inside rather than leaving no guard at all.

use super::{reported_pid, Options, Parent, LAUNCH, LAUNCH_FAILED, WATCH};
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, FILETIME, HANDLE, STILL_ACTIVE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, GetProcessTimes,
    OpenProcess, WaitForSingleObject, CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP,
    CREATE_NO_WINDOW, DETACHED_PROCESS, PROCESS_CREATION_FLAGS, PROCESS_INFORMATION,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, STARTUPINFOW,
};

/// No console, its own Ctrl+C group, and no window: the guard is invisible and deaf to the
/// signals that end Hearth's console.
const DETACHED: PROCESS_CREATION_FLAGS =
    PROCESS_CREATION_FLAGS(DETACHED_PROCESS.0 | CREATE_NEW_PROCESS_GROUP.0 | CREATE_NO_WINDOW.0);

/// How long Hearth waits for the launcher to report the guard. It only starts one process.
const LAUNCH_WAIT_MS: u32 = 10_000;

/// A process handle that closes itself.
pub struct Process {
    pub pid: u32,
    handle: HANDLE,
}

// A process handle may be waited on from any thread.
unsafe impl Send for Process {}
unsafe impl Sync for Process {}

impl Process {
    pub fn handle(&self) -> HANDLE {
        self.handle
    }

    pub fn has_exited(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_OBJECT_0 }
    }

    /// The exit code once it has exited.
    pub fn exit_code(&self) -> Option<u32> {
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.handle, &mut code) }.ok()?;
        (code != STILL_ACTIVE.0 as u32).then_some(code)
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// A started process, and whether it left its parent's job.
pub struct Spawned {
    pub process: Process,
    pub broke_away: bool,
}

/// The command line Windows hands to the new process, quoted the way the C runtime and Rust's
/// args_os read it back, so a path with spaces stays one argument.
pub fn command_line(exe: &Path, args: &[OsString]) -> Vec<u16> {
    let mut line: Vec<u16> = Vec::new();
    for (i, arg) in std::iter::once(exe.as_os_str())
        .chain(args.iter().map(|a| a.as_os_str()))
        .enumerate()
    {
        if i > 0 {
            line.push(u16::from(b' '));
        }
        quote_into(&mut line, arg);
    }
    line.push(0);
    line
}

fn quote_into(line: &mut Vec<u16>, arg: &OsStr) {
    let wide: Vec<u16> = arg.encode_wide().collect();
    let plain = !wide.is_empty()
        && !wide
            .iter()
            .any(|&c| c == u16::from(b' ') || c == u16::from(b'\t') || c == u16::from(b'"'));
    if plain {
        line.extend_from_slice(&wide);
        return;
    }
    line.push(u16::from(b'"'));
    let mut slashes = 0usize;
    for &c in &wide {
        if c == u16::from(b'\\') {
            slashes += 1;
            continue;
        }
        // Backslashes count only before a quote: double them there, and escape the quote.
        let times = if c == u16::from(b'"') {
            slashes * 2 + 1
        } else {
            slashes
        };
        line.extend(std::iter::repeat_n(u16::from(b'\\'), times));
        slashes = 0;
        line.push(c);
    }
    // The closing quote follows, so trailing backslashes are doubled too.
    line.extend(std::iter::repeat_n(u16::from(b'\\'), slashes * 2));
    line.push(u16::from(b'"'));
}

/// Starts `exe` detached, in its own folder (so it never holds the install folder open), with no
/// inherited handles. Leaving the job is tried first; a job that refuses it fails the start with
/// access denied, and the start is tried again inside the job.
pub fn spawn_detached(exe: &Path, args: &[OsString]) -> windows::core::Result<Spawned> {
    let app: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
    let dir: Option<Vec<u16>> = exe
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.as_os_str().encode_wide().chain([0]).collect());
    let dir_ptr = dir.as_ref().map_or(PCWSTR::null(), |d| PCWSTR(d.as_ptr()));
    let start = |flags: PROCESS_CREATION_FLAGS| -> windows::core::Result<Process> {
        // CreateProcessW may write into the command line, so each try gets its own copy.
        let mut line = command_line(exe, args);
        let info = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut started = PROCESS_INFORMATION::default();
        unsafe {
            CreateProcessW(
                PCWSTR(app.as_ptr()),
                Some(PWSTR(line.as_mut_ptr())),
                None,
                None,
                false,
                flags,
                None,
                dir_ptr,
                &info,
                &mut started,
            )?;
            let _ = CloseHandle(started.hThread);
        }
        Ok(Process {
            pid: started.dwProcessId,
            handle: started.hProcess,
        })
    };
    match start(DETACHED | CREATE_BREAKAWAY_FROM_JOB) {
        Ok(process) => Ok(Spawned {
            process,
            broke_away: true,
        }),
        Err(e) if e.code() == ERROR_ACCESS_DENIED.to_hresult() => {
            start(DETACHED).map(|process| Spawned {
                process,
                broke_away: false,
            })
        }
        Err(e) => Err(e),
    }
}

/// The creation time of the process behind `handle`, as the guard compares it.
pub fn process_start(handle: HANDLE) -> Option<u64> {
    let mut times = [FILETIME::default(); 4];
    let [created, exited, kernel, user] = &mut times;
    unsafe { GetProcessTimes(handle, created, exited, kernel, user) }.ok()?;
    let created = times[0];
    Some((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// This process as a guard's parent.
pub fn this_process() -> Parent {
    Parent {
        pid: unsafe { GetCurrentProcessId() },
        start: process_start(unsafe { GetCurrentProcess() }).unwrap_or(0),
    }
}

/// Opens the parent to wait on, if it is still the process that started the guard. None when
/// it is gone, or its pid now belongs to a later process.
pub fn open_parent(parent: Parent) -> Option<Process> {
    let access = PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;
    let handle = unsafe { OpenProcess(access, false, parent.pid) }.ok()?;
    let process = Process {
        pid: parent.pid,
        handle,
    };
    let same = process_start(handle) == Some(parent.start) && !process.has_exited();
    same.then_some(process)
}

/// Hearth's call: starts the guard watching this process and opens it, so Hearth can see it
/// end and start another.
pub fn launch(exe: &Path, options: &Options) -> io::Result<Process> {
    let mut args = vec![OsString::from(LAUNCH)];
    args.extend(options.to_args());
    let launcher = spawn_detached(exe, &args)
        .map_err(io::Error::other)?
        .process;
    let waited = unsafe { WaitForSingleObject(launcher.handle(), LAUNCH_WAIT_MS) };
    if waited == WAIT_TIMEOUT {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "the guard's launcher did not finish",
        ));
    }
    let code = launcher.exit_code().unwrap_or(LAUNCH_FAILED);
    let pid = reported_pid(code)
        .ok_or_else(|| io::Error::other(format!("the guard's launcher failed with code {code}")))?;
    let access = PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION;
    let handle = unsafe { OpenProcess(access, false, pid) }.map_err(io::Error::other)?;
    let guard = Process { pid, handle };
    if guard.has_exited() {
        return Err(io::Error::other("the guard ended as it started"));
    }
    Ok(guard)
}

/// The launcher's half: starts the watching guard and returns the exit code that reports it.
pub fn relaunch(options: &Options) -> u32 {
    let Ok(exe) = std::env::current_exe() else {
        return LAUNCH_FAILED;
    };
    let mut args = vec![OsString::from(WATCH)];
    args.extend(options.to_args());
    match spawn_detached(&exe, &args) {
        Ok(spawned) => spawned.process.pid,
        Err(_) => LAUNCH_FAILED,
    }
}
