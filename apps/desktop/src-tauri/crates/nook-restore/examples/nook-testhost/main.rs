// The test host for Nook's kill tests (docs/nook-wm.md, "Testing"): a stand-in for hearth.exe's
// window manager, without Tauri. It starts the guard the way Hearth will, claims the journal,
// beats, and adopts, moves, borders and hides the test windows it is given, through RealDesktop
// and in write-ahead order. The tests kill it, its guard or both at random points and check that
// every test window comes back. Like nook-testwin it runs only on a NookTest private desktop.
//
//   nook-testhost run --dir=D --tag=T --guard=EXE --windows=0x1a2b:normal,0x1c3d:maximized
//                     [--beat-ms=N] [--step-ms=N] [--until=K] [--stall-at=K] [--stall-delay-ms=N]
//   nook-testhost start --dir=D --tag=T
//
// It prints `plan N`, `guard PID`, `step K LABEL` before each step, `idle`, and how any restore
// or refused write went, one line each, for the test to follow.

#[cfg(windows)]
#[path = "../shared/desktop.rs"]
mod desktop;
#[cfg(windows)]
mod host;
#[cfg(windows)]
mod steps;

/// The version the host journals and passes on, so every restorer reads the journal as this
/// version's own.
pub const VERSION: &str = "0.0.0-killtest";

#[cfg(windows)]
fn main() {
    use nook_restore::journal::Store;
    use nook_restore::objects::session::SessionObjects;
    use nook_restore::placement::Hwnd;
    use nook_restore::recover::{at_start, Context, Start};
    use nook_restore::RealDesktop;
    use std::path::PathBuf;
    use std::time::Duration;

    unsafe {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        // Hearth's event loop makes the process per-monitor-v2 aware; the host does the same so
        // it journals placements the way the window manager will.
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
    desktop::require_test_desktop("nook-testhost");

    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| -> Option<String> {
        let prefix = format!("--{name}=");
        args.iter()
            .find_map(|a| a.strip_prefix(prefix.as_str()).map(str::to_string))
    };
    let number = |name: &str| value(name).and_then(|v| v.parse::<u64>().ok());
    let (Some(dir), Some(tag)) = (value("dir"), value("tag")) else {
        eprintln!("nook-testhost needs --dir and --tag.");
        std::process::exit(2);
    };
    if tag.chars().all(|c| c.is_ascii_digit()) {
        // A bare number is a session id: the live objects. Tests always use a tag of their own.
        eprintln!("nook-testhost won't use the session's own objects ({tag}).");
        std::process::exit(2);
    }
    let store = Store::in_dir(&PathBuf::from(&dir));
    let objects = SessionObjects::create(&tag).expect("the test's shared objects");

    if args.first().map(String::as_str) == Some("start") {
        let ctx = Context::current(Some(VERSION.to_string()));
        let line = match at_start(&RealDesktop::restoring(), &store, &objects, &ctx) {
            Start::Nothing => "start nothing".to_string(),
            Start::Resume(_) => "start resume".to_string(),
            Start::WriterAlive => "start writer-alive".to_string(),
            Start::Restored(r) | Start::Retried(r) => {
                format!("start restored {} {}", r.restored, r.failed.len())
            }
        };
        host::say(&line);
        return;
    }

    let mut windows = Vec::new();
    for item in value("windows").unwrap_or_default().split(',') {
        let Some((hwnd, state)) = item.split_once(':') else {
            continue;
        };
        let Ok(raw) = usize::from_str_radix(hwnd.trim_start_matches("0x"), 16) else {
            continue;
        };
        windows.push((Hwnd(raw as isize), state == "maximized"));
    }
    let Some(guard) = value("guard") else {
        eprintln!("nook-testhost run needs --guard.");
        std::process::exit(2);
    };
    let config = host::Config {
        dir: PathBuf::from(dir),
        tag,
        guard: PathBuf::from(guard),
        windows,
        beat: Duration::from_millis(number("beat-ms").unwrap_or(5000)),
        step: Duration::from_millis(number("step-ms").unwrap_or(0)),
        until: number("until").map(|k| k as usize),
        stall_at: number("stall-at").map(|k| k as usize),
        stall_delay: Duration::from_millis(number("stall-delay-ms").unwrap_or(0)),
    };
    host::run(config, store, objects);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("nook-testhost drives Windows windows, so it runs only on Windows.");
    std::process::exit(3);
}
