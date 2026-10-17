// nook-guard's side of the library (docs/nook-wm.md, "Architecture", process 2). Hearth starts
// the guard with `spawn::launch` once Nook may change a window; the guard then runs `watch::run`
// until Hearth ends, stops beating or a restore finishes, and restores from the journal if Hearth
// can't. The arguments are built and read here, so the app and the guard copy it starts always
// agree on them.

use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(windows)]
pub mod spawn;
#[cfg(windows)]
pub mod watch;

/// The first start: starts the watching guard and exits, reporting it.
pub const LAUNCH: &str = "--launch";
/// The guard proper.
pub const WATCH: &str = "--watch";

/// How often the guard reads the heartbeat while something is journaled.
pub const BEAT: Duration = Duration::from_secs(5);
/// Beats missed in a row before the guard decides the window manager is wedged: 15 s at 5 s.
pub const MISSED_BEATS: u32 = 3;
/// How long the guard leaves a requested restore to the app (which may resume after an update)
/// before it restores itself. Longer than the CLI's own wait, so the CLI goes first.
pub const RESTORE_GRACE: Duration = Duration::from_secs(5);

/// A heartbeat period outside this range is a typo, not a choice, and gets the default. Tests
/// use a short one so a wedged window manager is caught in under a second.
const BEAT_MS: std::ops::RangeInclusive<u64> = 50..=60_000;

/// The process the guard watches: its pid and creation time (FILETIME as u64). The time tells
/// Hearth apart from a later process that got the same pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parent {
    pub pid: u32,
    pub start: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub parent: Parent,
    /// Where the journal is; the default folder when not given.
    pub nook_dir: Option<PathBuf>,
    /// Names the shared objects; the session id when not given.
    pub tag: Option<String>,
    pub hearth_version: Option<String>,
    pub beat: Duration,
}

impl Options {
    pub fn new(parent: Parent) -> Options {
        Options {
            parent,
            nook_dir: None,
            tag: None,
            hearth_version: None,
            beat: BEAT,
        }
    }

    /// The arguments that carry these options, after LAUNCH or WATCH.
    pub fn to_args(&self) -> Vec<OsString> {
        let mut args = vec![OsString::from(format!(
            "--parent={}:{}",
            self.parent.pid, self.parent.start
        ))];
        if let Some(dir) = &self.nook_dir {
            let mut arg = OsString::from("--nook-dir=");
            arg.push(dir.as_os_str());
            args.push(arg);
        }
        if let Some(tag) = &self.tag {
            args.push(format!("--nook-tag={tag}").into());
        }
        if let Some(version) = &self.hearth_version {
            args.push(format!("--hearth-version={version}").into());
        }
        if self.beat != BEAT {
            args.push(format!("--beat-ms={}", self.beat.as_millis()).into());
        }
        args
    }
}

/// What the guard was started to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Role {
    Launch(Options),
    Watch(Options),
}

/// Reads the guard's arguments (the first is the program). None when they name neither role,
/// or name no parent to watch, which only a person typing the command would do.
pub fn parse<I, S>(args: I) -> Option<Role>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args: Vec<OsString> = args.into_iter().map(Into::into).skip(1).collect();
    let mut role = None;
    let mut parent = None;
    let mut options = Options::new(Parent { pid: 0, start: 0 });
    for arg in &args {
        let text = arg.to_string_lossy();
        if text == LAUNCH || text == WATCH {
            role = Some(text.into_owned());
        } else if let Some(value) = text.strip_prefix("--parent=") {
            parent = parse_parent(value);
        } else if let Some(value) = text.strip_prefix("--nook-dir=") {
            options.nook_dir = (!value.is_empty()).then(|| PathBuf::from(value));
        } else if let Some(value) = text.strip_prefix("--nook-tag=") {
            options.tag = (!value.is_empty()).then(|| value.to_string());
        } else if let Some(value) = text.strip_prefix("--hearth-version=") {
            options.hearth_version = (!value.is_empty()).then(|| value.to_string());
        } else if let Some(value) = text.strip_prefix("--beat-ms=") {
            if let Some(ms) = value.parse().ok().filter(|ms| BEAT_MS.contains(ms)) {
                options.beat = Duration::from_millis(ms);
            }
        }
    }
    options.parent = parent?;
    match role?.as_str() {
        LAUNCH => Some(Role::Launch(options)),
        _ => Some(Role::Watch(options)),
    }
}

fn parse_parent(value: &str) -> Option<Parent> {
    let (pid, start) = value.split_once(':')?;
    Some(Parent {
        pid: pid.parse().ok()?,
        start: start.parse().ok()?,
    })
}

/// The launcher's exit code when it could not start the guard. Process ids are multiples of
/// four, so no guard's pid is ever 1.
pub const LAUNCH_FAILED: u32 = 1;

/// Whether a launcher's exit code names a guard (a pid) rather than a failure.
pub fn reported_pid(exit_code: u32) -> Option<u32> {
    (exit_code > 4 && exit_code.is_multiple_of(4)).then_some(exit_code)
}
