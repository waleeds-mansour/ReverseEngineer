// nook.log's file handling and its restore line (docs/nook-wm.md, "FAILURE REPORTING"), shared by
// every party that restores: Hearth's diag module, the --nook-restore-windows CLI and the guard.
// One line per event, at most KEEP files of MAX_BYTES each. Each line goes out in one append, so
// lines from two processes never mix; a rotation the other process races with costs at most a
// line, never a restore.

use crate::recover::Report;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "nook.log";
/// One file's size limit; the oldest of KEEP files is dropped when the newest fills up.
pub const MAX_BYTES: u64 = 1024 * 1024;
pub const KEEP: usize = 3;
/// A message from outside Nook (a panic's, an OS error's) is cut to this many characters.
const MAX_MESSAGE: usize = 300;

pub fn file(dir: &Path, n: usize) -> PathBuf {
    if n == 0 {
        dir.join(FILE_NAME)
    } else {
        dir.join(format!("nook.{n}.log"))
    }
}

/// Appends one finished line (with its newline) to nook.log in `dir`, rotating first when it
/// wouldn't fit.
pub fn append(dir: &Path, line: &str) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = file(dir, 0);
    let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if len > 0 && len + line.len() as u64 > MAX_BYTES {
        rotate(dir);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?
        .write_all(line.as_bytes())
}

/// nook.log becomes nook.1.log, nook.1.log becomes nook.2.log, and the old nook.2.log goes.
fn rotate(dir: &Path) {
    for n in (1..KEEP).rev() {
        let from = file(dir, n - 1);
        if from.exists() {
            let _ = fs::rename(&from, file(dir, n));
        }
    }
}

/// Keeps a message on one short line, so a log line is always one event.
pub fn one_line(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_MESSAGE)
        .collect()
}

/// A unix time in ms as RFC 3339 in UTC with milliseconds, like 2026-10-17T09:05:03.042Z.
pub fn stamp(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let (days, rest) = (secs / 86_400, secs % 86_400);
    let (y, m, d) = civil(days);
    let (hh, mm, ss) = (rest / 3600, rest % 3600 / 60, rest % 60);
    let ms = unix_ms % 1000;
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.{ms:03}Z")
}

/// Days since 1970-01-01 to a calendar date, a year and then a month at a time: a log line's
/// date doesn't need anything faster.
fn civil(mut days: u64) -> (u64, u64, u64) {
    let leap = |y: u64| (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400);
    let mut year = 1970;
    loop {
        let len = if leap(year) { 366 } else { 365 };
        if days < len {
            break;
        }
        days -= len;
        year += 1;
    }
    let february = if leap(year) { 29 } else { 28 };
    let months = [31, february, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for len in months {
        if days < len {
            break;
        }
        days -= len;
        month += 1;
    }
    (year, month, days + 1)
}

/// A restore's line: who ran it and what it did, in numbers.
pub struct Restored<'a> {
    pub by: &'a str,
    pub report: &'a Report,
}

impl fmt::Display for Restored<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let r = self.report;
        write!(
            f,
            "restored by={} windows={} skipped={} failed={} second_pass={} locked={}",
            self.by,
            r.restored,
            r.skipped,
            r.failed.len(),
            r.second_pass_fixes,
            r.locked
        )?;
        if let Some(late) = r.late_pass_fixes {
            write!(f, " late_pass={late}")?;
        }
        if let Some(swept) = r.swept {
            write!(f, " swept={swept}")?;
        }
        if r.dropped {
            f.write_str(" dropped=other-boot")?;
        }
        if r.conservative {
            f.write_str(" conservative=other-version")?;
        }
        if let Some(e) = &r.journal_error {
            write!(f, " journal_error={}", one_line(e))?;
        }
        Ok(())
    }
}

/// The CLI's and the guard's line for a restore they ran. Only into a folder Nook already made:
/// a restore on a PC where Nook never ran has nothing to say, and makes no folder to say it in.
pub fn restored(dir: &Path, by: &str, report: &Report) {
    if dir.is_dir() {
        let line = format!(
            "{} {}\n",
            stamp(crate::clock::now_ms()),
            Restored { by, report }
        );
        let _ = append(dir, &line);
    }
}
