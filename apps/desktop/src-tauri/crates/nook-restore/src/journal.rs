// The restore journal, schema v2 (docs/nook-wm.md, "RESTORE JOURNAL"). Nook writes it before it
// touches another app's window, so whoever restores later knows each window's original placement,
// how it was hidden and which DWM attributes Nook set. It is replaced atomically: a reader sees
// the last complete journal or the one before it, never half of one.

use crate::placement::{Hwnd, Placement, Rect};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

mod writer;
pub(crate) use writer::stamp;
pub use writer::{WriteError, Writer};

pub const SCHEMA: u32 = 2;
pub const FILE_NAME: &str = "journal.json";

/// A journal far past the 20 KB design size is not one Nook wrote; reading it whole could stall a
/// restore, so it counts as corrupt and the marker sweep runs instead.
const MAX_BYTES: u64 = 1 << 20;
/// A temp file this old belongs to a writer that died before its rename; a live one keeps its
/// temp file for milliseconds, or a few seconds on a slow disk.
const STALE_TEMP: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum State {
    /// Nook may have changed windows; a restore is owed if Nook stops.
    Active,
    /// A restorer started and did not finish.
    Restoring,
    /// Windows was ending the session; hidden windows were shown, positions kept.
    SessionEnding,
    /// Put back for an update, positions kept; Nook resumes in the new version.
    CleanForUpdate,
    /// Nothing is owed.
    #[default]
    Clean,
}

impl State {
    pub fn is_clean(self) -> bool {
        matches!(self, State::Clean | State::CleanForUpdate)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Hidden {
    Minimized,
    Cloaked,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HiddenBy {
    Nook,
    /// The app hid itself (a tray app) right after Nook minimized it.
    AppAfterNook,
}

/// Everything about one window that a restore needs. Every field has a default so a journal from
/// another version still reads, and is then restored conservatively.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WindowEntry {
    pub hwnd: Hwnd,
    pub pid: u32,
    pub proc_start: u64,
    pub exe: String,
    pub class: String,
    pub original: Placement,
    pub hide_placement: Option<Placement>,
    pub hidden: Option<Hidden>,
    pub hidden_by: Option<HiddenBy>,
    pub user_minimized: bool,
    pub user_maximized: bool,
    pub monitor: String,
    pub rc_work: Rect,
    pub border_set: bool,
    pub transitions_disabled: bool,
    pub last_set: Option<Rect>,
}

impl WindowEntry {
    /// Whether the window may still show something Nook did to it: hidden, coloured or with its
    /// transitions off. A restore that couldn't undo one of these keeps the entry, so the next
    /// restorer tries again.
    pub fn owes(&self) -> bool {
        self.hidden.is_some() || self.border_set || self.transitions_disabled
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppBar {
    pub hwnd: Hwnd,
    pub edge: u32,
    pub rect: Rect,
    pub monitor: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Ring {
    pub hwnd: Hwnd,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Journal {
    pub v: u32,
    pub hearth_version: String,
    /// The window manager run that wrote it.
    pub session: String,
    /// Raised by every writer that takes over and every restorer; an older writer can't write.
    pub epoch: u64,
    /// The writing process, so the next start can tell whether it is gone.
    pub pid: u32,
    pub proc_start: u64,
    /// When Windows started, in unix ms, for people reading the file. It moves with every clock
    /// correction, so `ticks` is what tells boots apart.
    pub boot_time: u64,
    /// Windows' tick count at the last write. It only goes back to zero when Windows starts, so a
    /// tick count now below it means the journal is from an earlier boot. Zero (a journal from
    /// before this field) reads as this boot's.
    pub ticks: u64,
    pub state: State,
    pub resume: bool,
    pub seq: u64,
    pub written_at: u64,
    /// When Nook ended uncleanly, in unix ms, newest last; two within 10 minutes mean safe start.
    pub unclean: Vec<u64>,
    pub windows: Vec<WindowEntry>,
    pub appbars: Vec<AppBar>,
    pub ring: Option<Ring>,
}

impl Journal {
    /// A fresh journal for one window manager run, with nothing journaled yet.
    pub fn new(
        hearth_version: &str,
        session: String,
        pid: u32,
        proc_start: u64,
        boot: u64,
    ) -> Self {
        Journal {
            v: SCHEMA,
            hearth_version: hearth_version.to_string(),
            session,
            pid,
            proc_start,
            boot_time: boot,
            state: State::Active,
            ..Journal::default()
        }
    }

    /// Whether anything in it could still be on screen in a changed state.
    pub fn owes_restore(&self) -> bool {
        !self.state.is_clean()
            || self.windows.iter().any(WindowEntry::owes)
            || !self.appbars.is_empty()
    }

    /// Records an unclean end, keeping the last few: safe start only looks at the newest two.
    pub fn note_unclean(&mut self, at_ms: u64) {
        self.unclean.push(at_ms);
        let extra = self.unclean.len().saturating_sub(8);
        self.unclean.drain(..extra);
    }
}

/// An id for one window manager run. It only has to differ between runs on this PC, so it mixes
/// the process, its start time and the clock instead of pulling in a random-number crate.
pub fn new_session_id(pid: u32, proc_start: u64, now_nanos: u128) -> String {
    let mut x = (pid as u64) ^ proc_start.rotate_left(17) ^ (now_nanos as u64);
    let mut next = || {
        x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = x;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    let (a, b) = (next(), next());
    format!(
        "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
        a >> 32,
        (a >> 16) & 0xffff,
        a & 0xffff,
        b >> 48,
        b & 0xffff_ffff_ffff
    )
}

/// The epoch for a writer or restorer taking over: above the file's, and at least the clock in
/// ms, so even a restorer that finds the journal unreadable still outranks any earlier writer.
pub fn next_epoch(seen: Option<u64>, now_ms: u64) -> u64 {
    seen.map_or(0, |e| e.saturating_add(1)).max(now_ms)
}

#[derive(Debug)]
pub enum Loaded {
    Missing,
    /// Unreadable: not JSON, not a journal, or far too large. Why, for the log.
    Corrupt(String),
    Found(Journal),
}

/// Where the journal lives, and its atomic write.
#[derive(Clone, Debug)]
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn new(path: impl Into<PathBuf>) -> Store {
        Store { path: path.into() }
    }

    pub fn in_dir(dir: &Path) -> Store {
        Store::new(dir.join(FILE_NAME))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The folder the journal is in, which nook.log shares.
    pub fn dir(&self) -> &Path {
        self.path.parent().unwrap_or(Path::new("."))
    }

    /// A temp file of this write's own: the process and a count, so two writers (a restorer
    /// that went on without the mutex, say) never write into each other's file, and every
    /// rename moves one whole journal.
    pub fn temp_path(&self) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let mut name = self.path.as_os_str().to_owned();
        name.push(format!(".{}-{n}.tmp", std::process::id()));
        PathBuf::from(name)
    }

    /// Removes temp files left by writers that died before their rename. Best effort: a file
    /// that won't go is tried again next time.
    pub fn tidy(&self) {
        let (Some(dir), Some(name)) = (self.path.parent(), self.path.file_name()) else {
            return;
        };
        let prefix = format!("{}.", name.to_string_lossy());
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        let now = SystemTime::now();
        for entry in entries.flatten() {
            let file = entry.file_name();
            let file = file.to_string_lossy();
            if !file.starts_with(&prefix) || !file.ends_with(".tmp") {
                continue;
            }
            let modified = entry.metadata().and_then(|m| m.modified());
            let age = modified.ok().and_then(|at| now.duration_since(at).ok());
            if age.is_some_and(|age| age >= STALE_TEMP) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }

    pub fn load(&self) -> Loaded {
        let file = match busy_retry(|| File::open(&self.path)) {
            Ok(file) => file,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Loaded::Missing,
            Err(e) => return Loaded::Corrupt(format!("can't open: {e}")),
        };
        match file.metadata() {
            Ok(meta) if meta.len() > MAX_BYTES => {
                return Loaded::Corrupt(format!("{} bytes", meta.len()))
            }
            Err(e) => return Loaded::Corrupt(format!("can't stat: {e}")),
            Ok(_) => {}
        }
        let bytes = match busy_retry(|| fs::read(&self.path)) {
            Ok(bytes) => bytes,
            Err(e) => return Loaded::Corrupt(format!("can't read: {e}")),
        };
        match serde_json::from_slice::<Journal>(&bytes) {
            Ok(journal) => Loaded::Found(journal),
            Err(e) => Loaded::Corrupt(format!("not a journal: {e}")),
        }
    }

    /// Writes the whole journal to the temp file, flushes it to disk, then renames it over the
    /// old one with write-through. A crash at any point leaves the previous complete journal.
    pub fn save(&self, journal: &Journal) -> io::Result<()> {
        let bytes = serde_json::to_vec(journal).map_err(io::Error::other)?;
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = self.temp_path();
        let written = File::create(&tmp).and_then(|mut file| {
            file.write_all(&bytes)?;
            file.sync_all()
        });
        let result = written.and_then(|()| replace(&tmp, &self.path));
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    /// Keeps an unreadable journal beside the new one, for the log, before it is replaced.
    pub fn keep_bad_copy(&self) {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".bad");
        let _ = fs::copy(&self.path, PathBuf::from(name));
    }
}

/// Retries for a moment while Windows says the file is busy: another writer's rename onto the
/// journal holds it for that instant, and a reader mustn't take the journal for unreadable, nor a
/// writer give up, because of it. A busy file for more than about 100 ms is an error.
fn busy_retry<T>(mut f: impl FnMut() -> io::Result<T>) -> io::Result<T> {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    let mut tries = 20;
    loop {
        match f() {
            Err(e) if tries > 0 && busy(&e, ERROR_SHARING_VIOLATION) => {
                tries -= 1;
                std::thread::sleep(Duration::from_millis(5));
            }
            other => return other,
        }
    }
}

fn busy(e: &io::Error, sharing: i32) -> bool {
    e.kind() == io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(sharing)
}

#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> io::Result<()> {
    busy_retry(|| move_over(from, to))
}

#[cfg(windows)]
fn move_over(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain([0]).collect() };
    let (from, to) = (wide(from), wide(to));
    // Write-through, so the rename itself is on disk before Nook goes on to touch a window.
    unsafe {
        MoveFileExW(
            PCWSTR(from.as_ptr()),
            PCWSTR(to.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|e| io::Error::from_raw_os_error(e.code().0 & 0xffff))
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> io::Result<()> {
    fs::rename(from, to)?;
    if let Some(dir) = to.parent() {
        File::open(dir)?.sync_all()?;
    }
    Ok(())
}
