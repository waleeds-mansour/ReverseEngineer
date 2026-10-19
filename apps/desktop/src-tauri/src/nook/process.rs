// The real probe's process reads (docs/nook-wm.md, "STAGE C"), the hearth/foreground.rs pattern:
// OpenProcess with PROCESS_QUERY_LIMITED_INFORMATION and nothing more, which Windows grants even
// for elevated processes and which can't read or change the process. Nook asks this only for
// windows that passed the cheap checks, so a game's process is never opened for a window its
// class already ruled out. App names come from the exe's FileDescription, read from the file.

use super::probe::{Closed, Elevation, ProcessFacts};
use windows::core::{HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_ACCESS_DENIED, FILETIME, HANDLE};
use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// A handle closed when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

pub fn facts(pid: u32) -> Result<ProcessFacts, Closed> {
    let handle = match unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
        Ok(h) => Owned(h),
        Err(e) if e.code() == ERROR_ACCESS_DENIED.to_hresult() => return Err(Closed::Denied),
        Err(_) => return Err(Closed::Gone),
    };
    let path = image(handle.0).ok_or(Closed::Gone)?;
    Ok(ProcessFacts {
        path,
        start: started(handle.0),
        elevation: elevation(handle.0),
    })
}

fn image(h: HANDLE) -> Option<String> {
    let mut buf = [0u16; 1024];
    let mut len = buf.len() as u32;
    unsafe { QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) }
        .ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

fn started(h: HANDLE) -> u64 {
    let mut created = FILETIME::default();
    let [mut exited, mut kernel, mut user] = [FILETIME::default(); 3];
    if unsafe { GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) }.is_err() {
        return 0;
    }
    (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime)
}

fn elevation(h: HANDLE) -> Elevation {
    let mut token = HANDLE::default();
    if unsafe { OpenProcessToken(h, TOKEN_QUERY, &mut token) }.is_err() {
        return Elevation::Unknown;
    }
    let token = Owned(token);
    let mut info = TOKEN_ELEVATION::default();
    let mut len = 0u32;
    let read = unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            Some(&mut info as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    };
    match read {
        Ok(()) if info.TokenIsElevated != 0 => Elevation::Yes,
        Ok(()) => Elevation::No,
        Err(_) => Elevation::Unknown,
    }
}

/// Whether Hearth itself runs elevated. Then Windows lets it move any window, which is why the
/// panel offers only observing in that case (docs/nook-wm.md, "STAGE C").
pub fn own_elevated() -> bool {
    elevation(unsafe { GetCurrentProcess() }) == Elevation::Yes
}

/// The exe's FileDescription, like "Google Chrome", or None.
pub fn description(path: &str) -> Option<String> {
    let file = HSTRING::from(path);
    let size = unsafe { GetFileVersionInfoSizeW(PCWSTR(file.as_ptr()), None) };
    if size == 0 || size > 4 * 1024 * 1024 {
        return None;
    }
    // In u16s, so the block and the UTF-16 inside it start aligned; each read below is
    // unaligned-safe all the same.
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    unsafe {
        GetFileVersionInfoW(
            PCWSTR(file.as_ptr()),
            None,
            size,
            data.as_mut_ptr() as *mut core::ffi::c_void,
        )
    }
    .ok()?;
    let word = |p: *const core::ffi::c_void, i: usize| unsafe {
        (p as *const u16).add(i).read_unaligned()
    };
    let lang = query(&data, r"\VarFileInfo\Translation")
        .and_then(|(p, len)| (len >= 4).then(|| (word(p, 0), word(p, 1))));
    // The first translation the file lists, then US English in Unicode, the usual default.
    let mut tries = Vec::new();
    if let Some((l, cp)) = lang {
        tries.push(format!(r"\StringFileInfo\{l:04x}{cp:04x}\FileDescription"));
    }
    tries.push(r"\StringFileInfo\040904b0\FileDescription".to_string());
    for key in tries {
        if let Some((p, len)) = query(&data, &key) {
            let chars: Vec<u16> = (0..len as usize).map(|i| word(p, i)).collect();
            let text = String::from_utf16_lossy(&chars);
            let text = text.trim_end_matches('\0').trim();
            if !text.is_empty() {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn query(data: &[u16], key: &str) -> Option<(*const core::ffi::c_void, u32)> {
    let key = HSTRING::from(key);
    let mut out: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut len = 0u32;
    let ok = unsafe {
        VerQueryValueW(
            data.as_ptr() as *const core::ffi::c_void,
            PCWSTR(key.as_ptr()),
            &mut out,
            &mut len,
        )
    };
    (ok.as_bool() && !out.is_null() && len > 0).then_some((out as *const _, len))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reads Nook's own test process only: it is the one process a test may open freely.
    #[test]
    fn the_test_process_reads_as_itself_and_unelevated() {
        let me = std::process::id();
        let facts = facts(me).expect("its own process");
        assert!(
            facts.path.to_ascii_lowercase().ends_with(".exe"),
            "{}",
            facts.path
        );
        assert!(facts.start > 0);
        assert_eq!(facts.elevation == Elevation::Yes, own_elevated());
    }

    #[test]
    fn a_pid_that_isnt_running_is_gone() {
        // Pids are multiples of four, so this one never names a process.
        assert_eq!(facts(0xFFFF_FFF1).unwrap_err(), Closed::Gone);
    }

    #[test]
    fn a_system_exe_has_a_description() {
        let notepad = r"C:\Windows\System32\notepad.exe";
        if std::path::Path::new(notepad).exists() {
            assert!(description(notepad).is_some_and(|d| !d.is_empty()));
        }
        assert_eq!(description(r"C:\no\such\file.exe"), None);
    }
}
