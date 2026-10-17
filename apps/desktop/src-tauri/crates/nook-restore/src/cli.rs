// `hearth.exe --nook-restore-windows [--reason=user|update|uninstall] [--wait-ms=N] [--quiet]`
// (docs/nook-wm.md, "CLI branch"). Hearth's main.rs calls maybe_run before it parses its own
// flags, so the installer hooks and a person in a terminal can always get their windows back,
// even when Hearth itself is stuck. It first asks the running Hearth to restore, which can resume
// after an update; if nothing answers in time it revokes and restores on its own.
//
// hearth.exe is a windowed program, so a terminal doesn't wait for it and has no output from it
// unless it attaches to the terminal's console, which it does when not --quiet. `start /wait`
// (cmd) or `Start-Process -Wait` (PowerShell) waits for it and gives its exit code.
//
// Four more flags exist for callers that know better than the defaults: --nook-dir=PATH (the
// guard, which is told where the journal is), --hearth-version=V, --nook-tag=T, which names the
// shared objects instead of the session id so the kill tests never signal the live ones, and
// --by=NAME, who nook.log says ran the restore (the installer hooks pass installer).

use crate::recover::Reason;
use std::ffi::OsString;
use std::path::PathBuf;

pub const FLAG: &str = "--nook-restore-windows";

/// Long enough for a running Hearth to answer, short enough that an uninstall never feels stuck.
pub const DEFAULT_WAIT_MS: u32 = 2000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub reason: Reason,
    pub wait_ms: u32,
    pub quiet: bool,
    pub nook_dir: Option<PathBuf>,
    pub hearth_version: Option<String>,
    pub nook_tag: Option<String>,
    /// Who nook.log names as running the restore.
    pub by: String,
    /// Flags that were present but unusable, for a note; the restore still runs with defaults,
    /// because a typo should never leave windows hidden.
    pub ignored: Vec<String>,
}

/// None when the restore flag isn't among `args`, so Hearth carries on starting normally.
pub fn parse<I, S>(args: I) -> Option<Options>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args: Vec<String> = args
        .into_iter()
        .map(|a| a.into().to_string_lossy().into_owned())
        .collect();
    if !args.iter().any(|a| a == FLAG) {
        return None;
    }
    let mut options = Options {
        reason: Reason::User,
        wait_ms: DEFAULT_WAIT_MS,
        quiet: false,
        nook_dir: None,
        hearth_version: None,
        nook_tag: None,
        by: "cli".to_string(),
        ignored: Vec::new(),
    };
    // The first argument is the program itself; anything else unknown belongs to someone else.
    for arg in args.iter().skip(1) {
        if let Some(value) = arg.strip_prefix("--reason=") {
            match Reason::parse(value) {
                Some(reason) => options.reason = reason,
                None => options.ignored.push(arg.clone()),
            }
        } else if let Some(value) = arg.strip_prefix("--wait-ms=") {
            match value.parse() {
                Ok(ms) => options.wait_ms = ms,
                Err(_) => options.ignored.push(arg.clone()),
            }
        } else if let Some(value) = arg.strip_prefix("--nook-dir=") {
            options.nook_dir = (!value.is_empty()).then(|| PathBuf::from(value));
        } else if let Some(value) = arg.strip_prefix("--hearth-version=") {
            options.hearth_version = (!value.is_empty()).then(|| value.to_string());
        } else if let Some(value) = arg.strip_prefix("--nook-tag=") {
            options.nook_tag = (!value.is_empty()).then(|| value.to_string());
        } else if let Some(value) = arg.strip_prefix("--by=") {
            // A name for the log only: short, and lower-case letters, so it can't break a line.
            let short = (1..=16).contains(&value.len());
            if short && value.bytes().all(|b| b.is_ascii_lowercase()) {
                options.by = value.to_string();
            } else {
                options.ignored.push(arg.clone());
            }
        } else if arg == "--quiet" {
            options.quiet = true;
        }
    }
    Some(options)
}

/// The exit code for a finished restore: 0 when every window came back, 1 when some didn't.
pub fn exit_code(failed: usize) -> i32 {
    i32::from(failed > 0)
}

/// What the restore says when it ends. Shown in a terminal; the installer runs it quietly.
pub fn summary(restored: usize, failed: usize) -> String {
    let windows = |n: usize| if n == 1 { "window" } else { "windows" };
    match (restored, failed) {
        (0, 0) => "Nook had no windows to put back.".to_string(),
        (n, 0) => format!("Nook put {n} {} back.", windows(n)),
        (n, f) => format!(
            "Nook put {n} {} back and couldn't put {f} {} back.",
            windows(n),
            windows(f)
        ),
    }
}

/// Runs the restore when `args` ask for it and returns the exit code; None otherwise.
pub fn maybe_run<I, S>(args: I) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let options = parse(args)?;
    Some(run(&options))
}

#[cfg(not(windows))]
pub fn run(options: &Options) -> i32 {
    if !options.quiet {
        eprintln!("Nook arranges windows only on Windows, so there is nothing to put back.");
    }
    0
}

#[cfg(windows)]
pub use self::windows_run::{default_dir, run};

#[cfg(windows)]
mod windows_run {
    use super::{exit_code, summary, Options};
    use crate::desktop::real::RealDesktop;
    use crate::journal::{Loaded, State, Store};
    use crate::objects::session::{session_tag, SessionObjects};
    use crate::objects::{Signals, Unshared};
    use crate::recover::{restore_all, Context, Reason};
    use std::path::PathBuf;
    use std::time::Duration;

    /// Where the journal lives: beside the program in a portable install (the same marker file
    /// Hearth's portable mode reads), otherwise %LOCALAPPDATA%\app.hearth.desktop\nook.
    pub fn default_dir() -> PathBuf {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(PathBuf::from));
        if let Some(dir) = exe_dir {
            let marker = std::fs::read_to_string(dir.join("portable")).unwrap_or_default();
            if marker.trim().starts_with("Handy Portable Mode") {
                return dir.join("Data").join("nook");
            }
        }
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .map(|home| PathBuf::from(home).join("AppData\\Local"))
            })
            .unwrap_or_default();
        local.join("app.hearth.desktop").join("nook")
    }

    /// Whether the journal now reads as the asked-for restore having happened, with no window
    /// left that it couldn't put back.
    fn done_for(reason: Reason, store: &Store) -> bool {
        match store.load() {
            Loaded::Found(journal) if journal.owes_restore() => false,
            Loaded::Found(journal) if reason == Reason::Update => journal.state.is_clean(),
            Loaded::Found(journal) => journal.state == State::Clean,
            Loaded::Missing | Loaded::Corrupt(_) => false,
        }
    }

    pub fn run(options: &Options) -> i32 {
        set_dpi_awareness();
        if !options.quiet {
            attach_console();
        }
        let say = |text: &str| {
            if !options.quiet {
                eprintln!("{text}");
            }
        };
        for flag in &options.ignored {
            say(&format!(
                "Nook didn't understand {flag}, so it used the default."
            ));
        }
        let store = Store::in_dir(&options.nook_dir.clone().unwrap_or_else(default_dir));
        let tag = options.nook_tag.clone().unwrap_or_else(session_tag);
        let listening = SessionObjects::exists(&tag);
        let objects = SessionObjects::create(&tag).ok();

        if let (true, Some(objects)) = (listening && options.wait_ms > 0, objects.as_ref()) {
            objects.request_restore(options.reason);
            let answered = objects.wait_done(Duration::from_millis(options.wait_ms.into()));
            if answered && done_for(options.reason, &store) {
                say("Nook put the windows back.");
                return 0;
            }
        }

        let signals: &dyn Signals = match objects.as_ref() {
            Some(objects) => objects,
            None => &Unshared,
        };
        let ctx = Context::current(options.hearth_version.clone());
        let report = restore_all(
            &RealDesktop::restoring(),
            &store,
            signals,
            &ctx,
            options.reason,
        );
        crate::log::restored(store.dir(), &options.by, &report);
        say(&summary(report.restored, report.failed.len()));
        exit_code(report.failed.len())
    }

    /// Lets eprintln reach the terminal that started this windowed program. Only when stderr
    /// goes nowhere: a caller that redirected it (a pipe, a file) keeps what it chose.
    fn attach_console() {
        use windows::Win32::System::Console::{
            AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_ERROR_HANDLE,
        };
        let stderr = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        let nowhere = stderr.map_or(true, |h| h.is_invalid() || h.0.is_null());
        if nowhere {
            // No console to attach to (the installer, Explorer) is fine: there is no one to tell.
            unsafe {
                let _ = AttachConsole(ATTACH_PARENT_PROCESS);
            }
        }
    }

    /// Placements are in physical pixels for a per-monitor-v2 process, which is what the window
    /// manager was when it journaled them; this process must read and write them the same way.
    /// It runs only on the restore path, before Tauri would set it, so it never changes Hearth.
    fn set_dpi_awareness() {
        use windows::Win32::UI::HiDpi::{
            SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        };
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
    }
}
