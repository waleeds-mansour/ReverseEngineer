// Processes the harness started (or the host started for it): kill by handle, wait, and the
// numbers the design budgets for the guard. Every kill is TerminateProcess on a handle to a
// process this test made, never a kill by name; the one taskkill /T names the host's pid.

use std::process::Command;
use std::time::Duration;
use windows::core::PWSTR;
use windows::Wdk::System::SystemInformation::{NtQuerySystemInformation, SystemProcessInformation};
use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE, WAIT_OBJECT_0};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::JobObjects::IsProcessInJob;
use windows::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
    WaitForMultipleObjects, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, PROCESS_VM_READ,
};
use windows::Win32::System::WindowsProgramming::{
    QueryProcessCycleTime, SYSTEM_PROCESS_INFORMATION, SYSTEM_THREAD_INFORMATION,
};

/// The exit code the harness kills with, so a kill is told apart from a program's own end.
pub const KILLED: u32 = 0x4B11;

pub struct Proc {
    pub pid: u32,
    handle: HANDLE,
}

unsafe impl Send for Proc {}
unsafe impl Sync for Proc {}

impl Proc {
    pub fn from_handle(pid: u32, handle: HANDLE) -> Proc {
        Proc { pid, handle }
    }

    /// Opens the guard the host reported, to watch, measure and kill it. The pid is checked to
    /// still be a nook-guard.exe, so a pid reused by another program is never kept, let alone
    /// killed; once open, the handle stays that process's.
    pub fn open_guard(pid: u32) -> Option<Proc> {
        let access = PROCESS_TERMINATE
            | PROCESS_SYNCHRONIZE
            | PROCESS_QUERY_LIMITED_INFORMATION
            | PROCESS_VM_READ;
        let handle = unsafe { OpenProcess(access, false, pid) }.ok()?;
        let process = Proc { pid, handle };
        let image = process.image()?;
        image
            .rsplit('\\')
            .next()
            .is_some_and(|name| name.eq_ignore_ascii_case("nook-guard.exe"))
            .then_some(process)
    }

    /// The full path of the program the process runs.
    pub fn image(&self) -> Option<String> {
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let name = PWSTR(buf.as_mut_ptr());
        unsafe { QueryFullProcessImageNameW(self.handle, PROCESS_NAME_WIN32, name, &mut len) }
            .ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }

    pub fn kill(&self) {
        unsafe {
            let _ = TerminateProcess(self.handle, KILLED);
            let _ = WaitForSingleObject(self.handle, 5_000);
        }
    }

    /// Waits up to `timeout` for it to end; true when it has.
    pub fn wait(&self, timeout: Duration) -> bool {
        let ms = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        unsafe { WaitForSingleObject(self.handle, ms) == WAIT_OBJECT_0 }
    }

    pub fn exit_code(&self) -> Option<u32> {
        let mut code = 0u32;
        unsafe { GetExitCodeProcess(self.handle, &mut code) }.ok()?;
        (code != STILL_ACTIVE.0 as u32).then_some(code)
    }

    pub fn alive(&self) -> bool {
        self.exit_code().is_none()
    }

    pub fn private_bytes(&self) -> Option<usize> {
        let mut counters = PROCESS_MEMORY_COUNTERS_EX {
            cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
            ..Default::default()
        };
        let ptr = &mut counters as *mut PROCESS_MEMORY_COUNTERS_EX as *mut PROCESS_MEMORY_COUNTERS;
        unsafe { GetProcessMemoryInfo(self.handle, ptr, counters.cb) }.ok()?;
        Some(counters.PrivateUsage)
    }

    /// CPU cycles all its threads have used, user and kernel; it doesn't grow while every thread
    /// sleeps.
    pub fn cycles(&self) -> Option<u64> {
        let mut cycles = 0u64;
        unsafe { QueryProcessCycleTime(self.handle, &mut cycles) }.ok()?;
        Some(cycles)
    }

    /// Whether it is in any job.
    pub fn in_job(&self) -> Option<bool> {
        let mut inside = windows::core::BOOL(0);
        unsafe { IsProcessInJob(self.handle, None, &mut inside) }.ok()?;
        Some(inside.as_bool())
    }

    /// Whether it is in this job.
    pub fn in_job_of(&self, job: HANDLE) -> Option<bool> {
        let mut inside = windows::core::BOOL(0);
        unsafe { IsProcessInJob(self.handle, Some(job), &mut inside) }.ok()?;
        Some(inside.as_bool())
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// Waits until the journal in `dir` reads clean (a restorer's first pass has finished) or
/// `process` ends, by watching the folder for writes; true when it read clean.
pub fn wait_clean_journal(dir: &std::path::Path, process: &Proc, timeout: Duration) -> bool {
    use nook_restore::journal::{Loaded, Store};
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Storage::FileSystem::{
        FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
        FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
    };
    let store = Store::in_dir(dir);
    let clean = || matches!(store.load(), Loaded::Found(j) if j.state.is_clean());
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain([0]).collect();
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE;
    let path = windows::core::PCWSTR(wide.as_ptr());
    let Ok(change) = (unsafe { FindFirstChangeNotificationW(path, false, filter) }) else {
        return false;
    };
    let until = std::time::Instant::now() + timeout;
    let mut found = clean();
    while !found {
        let Some(left) = until.checked_duration_since(std::time::Instant::now()) else {
            break;
        };
        let ms = left.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        let woke = unsafe { WaitForMultipleObjects(&[change, process.handle], false, ms) };
        found = clean();
        if woke != WAIT_OBJECT_0 || unsafe { FindNextChangeNotification(change) }.is_err() {
            break;
        }
    }
    unsafe {
        let _ = FindCloseChangeNotification(change);
    }
    found
}

/// Every running process as (pid, parent pid, program name).
fn snapshot() -> Vec<(u32, u32, String)> {
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut all = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(0);
        let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
        all.push((entry.th32ProcessID, entry.th32ParentProcessID, name));
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    all
}

/// Whether the harness itself runs in a job (one it was started in, not the test's own).
pub fn harness_in_job() -> Option<bool> {
    use windows::Win32::System::Threading::GetCurrentProcess;
    let mut inside = windows::core::BOOL(0);
    unsafe { IsProcessInJob(GetCurrentProcess(), None, &mut inside) }.ok()?;
    Some(inside.as_bool())
}

/// When a process started (FILETIME as u64), if it still runs and can be asked.
pub fn created(pid: u32) -> Option<u64> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let start = nook_restore::guard::spawn::process_start(handle);
    unsafe {
        let _ = CloseHandle(handle);
    }
    start
}

/// The pid a process was started by, as taskkill /T sees it.
pub fn parent_pid(pid: u32) -> Option<u32> {
    snapshot().into_iter().find(|p| p.0 == pid).map(|p| p.1)
}

/// What taskkill /T on `pid` could reach: the process and everything whose recorded parent
/// chain leads to it. The parent pid alone is used, the widest reading, so a process whose
/// long-dead parent had this pid counts too.
pub fn tree(pid: u32) -> Vec<(u32, u32, String)> {
    let all = snapshot();
    let mut reach: Vec<(u32, u32, String)> = all.iter().filter(|p| p.0 == pid).cloned().collect();
    let mut i = 0;
    while i < reach.len() {
        let parent = reach[i].0;
        for p in all.iter().filter(|p| p.1 == parent && p.0 != parent) {
            if !reach.iter().any(|r| r.0 == p.0) {
                reach.push(p.clone());
            }
        }
        i += 1;
    }
    reach
}

/// Context switches into the process's threads so far, and how many threads it has. Each one
/// is a wakeup: a thread that never wakes adds none.
pub fn context_switches(pid: u32) -> Option<(u64, u32)> {
    const MISMATCH: i32 = 0xC000_0004_u32 as i32;
    let mut size = 1usize << 20;
    for _ in 0..8 {
        // u64s, so the buffer is aligned for the structures inside it.
        let mut buf = vec![0u64; size / 8];
        let mut needed = 0u32;
        let status = unsafe {
            NtQuerySystemInformation(
                SystemProcessInformation,
                buf.as_mut_ptr().cast(),
                (buf.len() * 8) as u32,
                &mut needed,
            )
        };
        if status.0 == MISMATCH {
            size = needed as usize + (1 << 16);
            continue;
        }
        if status.0 < 0 {
            return None;
        }
        let base = buf.as_ptr() as *const u8;
        let mut offset = 0usize;
        loop {
            let info = unsafe { &*(base.add(offset) as *const SYSTEM_PROCESS_INFORMATION) };
            if info.UniqueProcessId.0 as usize == pid as usize {
                let first =
                    unsafe { base.add(offset + std::mem::size_of::<SYSTEM_PROCESS_INFORMATION>()) }
                        as *const SYSTEM_THREAD_INFORMATION;
                let mut switches = 0u64;
                for t in 0..info.NumberOfThreads as usize {
                    // Reserved3 is ContextSwitches; winternl.h leaves it unnamed.
                    switches += u64::from(unsafe { (*first.add(t)).Reserved3 });
                }
                return Some((switches, info.NumberOfThreads));
            }
            if info.NextEntryOffset == 0 {
                return None;
            }
            offset += info.NextEntryOffset as usize;
        }
    }
    None
}

/// Runs `taskkill /T /F /PID pid` without a window, and returns what it printed.
pub fn taskkill_tree(pid: u32) -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .expect("taskkill runs");
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&out.stderr));
    text.trim().to_string()
}
