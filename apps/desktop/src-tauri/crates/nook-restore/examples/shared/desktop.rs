// Which desktop a test program runs on. The kill-test programs write to windows, so they refuse
// to start anywhere but a NookTest private desktop: run by hand, they stop before making or
// touching a single window on the owner's desktop.

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::StationsAndDesktops::{
    GetThreadDesktop, GetUserObjectInformationW, UOI_NAME,
};
use windows::Win32::System::Threading::GetCurrentThreadId;

/// The prefix every kill-test desktop's name starts with.
pub const PREFIX: &str = "NookTest-";

/// The name of a desktop or window station, such as "Default" or "WinSta0".
pub fn name_of(object: HANDLE) -> String {
    let mut buf = [0u16; 256];
    let size = std::mem::size_of_val(&buf) as u32;
    let mut needed = 0u32;
    let got = unsafe {
        GetUserObjectInformationW(
            object,
            UOI_NAME,
            Some(buf.as_mut_ptr().cast()),
            size,
            Some(&mut needed),
        )
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

/// Exits unless this thread is on a NookTest desktop.
pub fn require_test_desktop(program: &str) {
    let desktop = this_thread();
    if !desktop.starts_with(PREFIX) {
        eprintln!("{program} runs only on a {PREFIX} private desktop, not on {desktop:?}.");
        std::process::exit(3);
    }
}
