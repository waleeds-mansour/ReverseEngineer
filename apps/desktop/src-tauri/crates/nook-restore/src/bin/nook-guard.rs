// nook-guard.exe: puts Nook's windows back when Hearth can't (docs/nook-wm.md, "Architecture").
// Hearth runs a per-version copy of it as `--launch`, which starts the real guard (`--watch`)
// detached and exits, reporting the guard's pid as its exit code. The guard waits on Hearth's
// process and the shared events and restores from the journal if Hearth dies or stops beating.
// It also answers --nook-restore-windows, the same as hearth.exe does.

// No console window, ever: the guard runs detached and must never pop one on the desktop.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn main() {
    use nook_restore::guard::{parse, spawn, watch, Role};
    // First, before any window is read: placements are journaled in physical pixels by a
    // per-monitor-v2 process, and the guard must read and write them the same way.
    unsafe {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    if let Some(code) = nook_restore::cli::maybe_run(std::env::args_os()) {
        std::process::exit(code);
    }
    let code = match parse(std::env::args_os()) {
        // The exit code is the guard's pid, which is how Hearth finds the guard to watch it.
        Some(Role::Launch(options)) => spawn::relaunch(&options) as i32,
        Some(Role::Watch(options)) => watch::run(&options),
        None => {
            eprintln!(
                "Nook's guard is started by Nook. To put windows back, run it with \
                 --nook-restore-windows."
            );
            2
        }
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Nook arranges windows only on Windows, so its guard has nothing to do here.");
    std::process::exit(2);
}
