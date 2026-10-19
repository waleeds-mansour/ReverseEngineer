// nook.log (docs/nook-wm.md, "FAILURE REPORTING"): what Nook did about other apps' windows and
// why, kept on this PC only, in at most three files of 1 MB each. Lines are made from typed
// events rather than free text, and no event carries a window's title, so none can reach the log.
// Nothing is written, and no folder is made, until there is something to say. The file handling
// and the restore line are nook-restore's, which the CLI and the guard write with too.

use nook_restore::log::{append, one_line, stamp, Restored};
use nook_restore::Report;
use std::cell::Cell;
use std::fmt;
use std::path::Path;
use std::sync::Mutex;

/// One writer at a time, so lines from two threads never interleave or rotate twice.
static LOCK: Mutex<()> = Mutex::new(());

/// Who put the windows back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum By {
    /// Hearth starting, for a journal its last run left owing.
    Start,
    /// The settings window, before an update replaces Hearth.
    Update,
    /// A fresh thread, after a Nook thread panicked.
    Unwind,
    /// Hearth starting, for windows an earlier restore couldn't put back.
    Retry,
}

impl fmt::Display for By {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            By::Start => "start",
            By::Update => "update",
            By::Unwind => "unwind",
            By::Retry => "retry",
        })
    }
}

pub enum Event<'a> {
    /// The settings ask for something, and Nook is held off: by the disabled file, by safe start,
    /// or because this version has no window manager yet.
    HeldOff {
        why: &'a str,
    },
    Restored {
        by: By,
        report: &'a Report,
    },
    /// The last run's journal belongs to a copy of Hearth that is still running.
    WriterAlive,
    /// An update left windows to resume, and this version has no window manager to resume them.
    NotResumed,
    Panicked {
        thread: &'a str,
        at: &'a str,
        message: &'a str,
    },
    /// A Nook thread unwound; its restore runs next, on a fresh thread.
    Unwound {
        thread: &'a str,
    },
    /// A Nook thread ended without being asked to, and without a panic.
    Ended {
        thread: &'a str,
    },
    /// Hearth was told to quit while a restore was still running, and didn't wait longer.
    QuitDuringRestore,
    /// The observer started or stopped (P1), and why.
    Observing {
        on: bool,
        why: &'a str,
    },
    /// One of the gates tripped or cleared.
    Gate {
        name: &'a str,
        on: bool,
    },
    /// A monitor Nook arranges stayed away for 30 s.
    MonitorAway {
        name: &'a str,
    },
    /// The bar's windows were made or destroyed (P1), and why.
    Bar {
        on: bool,
        why: &'a str,
    },
    /// The bar or its popover was told it has the focus, and what became of the foreground: the
    /// first time for each outcome only.
    BarFocus {
        outcome: &'a str,
    },
}

impl fmt::Display for Event<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Event::HeldOff { why } => write!(f, "held off: {why}"),
            Event::Restored { by, report } => {
                let by = by.to_string();
                write!(f, "{}", Restored { by: &by, report })
            }
            Event::WriterAlive => {
                f.write_str("journal owed by another copy that is still running; left to it")
            }
            Event::NotResumed => f.write_str("update left windows to resume; nothing here resumes"),
            Event::Panicked {
                thread,
                at,
                message,
            } => write!(f, "panic in {thread} at {at}: {}", one_line(message)),
            Event::Unwound { thread } => write!(f, "{thread} unwound; restoring from the journal"),
            Event::Ended { thread } => write!(
                f,
                "{thread} ended without being asked; observing is off until Hearth starts again"
            ),
            Event::QuitDuringRestore => f.write_str("quit while a restore was still running"),
            Event::Observing { on, why } => {
                write!(f, "observing {}: {why}", if *on { "on" } else { "off" })
            }
            Event::Gate { name, on } => {
                write!(f, "gate {name} {}", if *on { "on" } else { "off" })
            }
            Event::MonitorAway { name } => write!(
                f,
                "monitor {name} stayed away for 30 s; observing, so nothing to put back"
            ),
            Event::Bar { on, why } => write!(f, "bar {}: {why}", if *on { "on" } else { "off" }),
            Event::BarFocus { outcome } => {
                write!(f, "the bar was focused; foreground {outcome} (first time)")
            }
        }
    }
}

thread_local! {
    /// Set while this thread is inside `write`, so a panic there doesn't wait on its own lock.
    static WRITING: Cell<bool> = const { Cell::new(false) };
}

/// Marks this thread as writing until it is dropped, which also happens while a panic unwinds.
struct Writing;

impl Writing {
    fn start() -> Writing {
        let _ = WRITING.try_with(|w| w.set(true));
        Writing
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        let _ = WRITING.try_with(|w| w.set(false));
    }
}

/// Adds a line to nook.log in `dir`. A log that can't be written is skipped: the log never stops
/// a restore.
pub fn write(dir: &Path, event: &Event<'_>) {
    let _held = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let _writing = Writing::start();
    let _ = append(dir, &line(event));
}

/// The panic hook's write. It waits for another thread's line like `write` does, since the panic
/// is the line most worth keeping. Only a thread that panicked inside `write` itself skips it: it
/// still holds the lock, and waiting for it there would never end.
pub fn write_from_hook(dir: &Path, event: &Event<'_>) {
    // A thread whose thread-locals are already gone counts as writing, to be safe.
    if WRITING.try_with(Cell::get).unwrap_or(true) {
        return;
    }
    write(dir, event);
}

fn line(event: &Event<'_>) -> String {
    let at = stamp(nook_restore::clock::now_ms());
    format!("{at} {event}\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use nook_restore::log::{file, KEEP, MAX_BYTES};
    use std::fs;

    fn read(dir: &Path, n: usize) -> String {
        fs::read_to_string(file(dir, n)).unwrap_or_default()
    }

    #[test]
    fn nothing_is_written_until_there_is_something_to_say() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("nook");
        assert!(!dir.exists());
        write(&dir, &Event::WriterAlive);
        assert!(read(&dir, 0)
            .ends_with("journal owed by another copy that is still running; left to it\n"));
    }

    #[test]
    fn a_restore_reads_as_numbers() {
        let report = Report {
            restored: 3,
            skipped: 1,
            swept: Some(2),
            locked: true,
            journal_error: Some("not a journal:\nline 1".into()),
            ..Report::default()
        };
        let text = Event::Restored {
            by: By::Start,
            report: &report,
        }
        .to_string();
        assert_eq!(
            text,
            "restored by=start windows=3 skipped=1 failed=0 second_pass=0 locked=true swept=2 \
             journal_error=not a journal: line 1"
        );
    }

    #[test]
    fn a_panic_message_stays_on_one_short_line() {
        let long = format!("first\nsecond {}", "x".repeat(1000));
        let text = Event::Panicked {
            thread: "nook-start",
            at: "src/nook/mod.rs:1",
            message: &long,
        }
        .to_string();
        assert!(!text.contains('\n'));
        assert!(text.len() < 400);
    }

    #[test]
    fn the_log_keeps_three_files_of_at_most_a_megabyte() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let big = "y".repeat(400 * 1024);
        let event = Event::HeldOff { why: &big };
        for _ in 0..10 {
            write(dir, &event);
        }
        for n in 0..KEEP {
            let len = fs::metadata(file(dir, n)).unwrap().len();
            assert!(len <= MAX_BYTES, "nook.{n}.log is {len} bytes");
        }
        assert!(!dir.join("nook.3.log").exists());
    }

    #[test]
    fn the_hook_skips_a_line_rather_than_wait_on_itself() {
        let tmp = tempfile::tempdir().unwrap();
        {
            // As if this thread had panicked halfway through a line of its own.
            let _writing = Writing::start();
            write_from_hook(tmp.path(), &Event::QuitDuringRestore);
        }
        assert_eq!(read(tmp.path(), 0), "");
        write_from_hook(tmp.path(), &Event::QuitDuringRestore);
        assert!(read(tmp.path(), 0).contains("quit while a restore"));
    }

    #[test]
    fn the_hook_waits_for_another_threads_line() {
        let tmp = tempfile::tempdir().unwrap();
        let held = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        let dir = tmp.path().to_path_buf();
        let hook = std::thread::spawn(move || write_from_hook(&dir, &Event::QuitDuringRestore));
        std::thread::sleep(std::time::Duration::from_millis(50));
        drop(held);
        hook.join().unwrap();
        assert!(read(tmp.path(), 0).contains("quit while a restore"));
    }
}
