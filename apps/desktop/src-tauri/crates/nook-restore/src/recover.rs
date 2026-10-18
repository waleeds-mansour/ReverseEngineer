// restore_all: the one restore every party runs (docs/nook-wm.md, "RECOVERY"). It is idempotent,
// so the guard, the CLI and the app may all run it for the same journal and the windows still end
// up where they belong. Its order matters: revoke first, so a stalled window manager can't move a
// window after it was put back; un-hide and place in one write that keeps the maximized state, so
// a maximized window comes back maximized; then a second pass a second later for writes that
// landed late, and a last one later still while the journal's writer may still be running.

use crate::clock::Clock;
use crate::desktop::Desktop;
use crate::journal::{next_epoch, stamp, Journal, Loaded, State, Store, WindowEntry, SCHEMA};
use crate::objects::{Held, Signals};
use std::time::Duration;

mod start;
mod steps;

pub use crate::clock::{boot_time_ms, now_ms};
pub use start::{at_start, Start, RESUME_WITHIN_MS};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reason {
    /// The CLI, the tray or the panel: put everything back and turn Nook off.
    User,
    /// The installer is about to update Hearth: show everything, keep positions, resume after.
    Update,
    /// The installer is removing Hearth: put everything back.
    Uninstall,
    Panic,
    Quit,
    /// Turning the window manager off keeps positions (the design's proposed default).
    Disable,
    /// The guard: Hearth died, or stopped beating.
    Guard,
    /// Hearth starting found a journal its last run left dirty.
    Start,
    /// A Nook thread panicked.
    Unwind,
    /// Windows is ending the session: show hidden windows and reset borders, nothing else.
    SessionEnd,
    /// Hearth starting found windows an earlier restore couldn't put back, and tries again. It
    /// keeps positions: by now the owner may have moved those windows, and a swept entry's
    /// original is only where the window was at the sweep.
    Retry,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Policy {
    /// Every window goes back to where it was before Nook adopted it.
    Originals,
    /// Windows stay where Nook put them; only hiding and borders are undone.
    Keep,
}

impl Reason {
    pub fn policy(self) -> Policy {
        match self {
            Reason::Update | Reason::Disable | Reason::SessionEnd | Reason::Retry => Policy::Keep,
            _ => Policy::Originals,
        }
    }

    /// Whether Nook ended without being asked to, which counts toward safe start. An update
    /// never does, and neither does trying again.
    pub fn unclean(self) -> bool {
        matches!(self, Reason::Guard | Reason::Start | Reason::Unwind)
    }

    /// The CLI's --reason values.
    pub fn parse(text: &str) -> Option<Reason> {
        match text {
            "user" => Some(Reason::User),
            "update" => Some(Reason::Update),
            "uninstall" => Some(Reason::Uninstall),
            _ => None,
        }
    }
}

/// What the restorer knows about now, passed in so tests can choose it.
#[derive(Clone, Debug)]
pub struct Context {
    pub now_ms: u64,
    /// When Windows started, for the journal a restore writes from scratch.
    pub boot_time_ms: u64,
    /// Windows' tick count now, which tells this boot's journal from an earlier boot's.
    pub ticks_ms: u64,
    /// The running Hearth's version, when the caller knows it. Without it only the journal
    /// schema decides whether the journal is this version's.
    pub hearth_version: Option<String>,
    /// How long to wait for the journal mutex before going on from the last complete journal.
    pub lock_wait: Duration,
    /// When to run the second pass; None skips it (a session ending has no second to spare).
    pub second_pass_after: Option<Duration>,
    /// When to check every window once more, after the second pass, if the journal's writer
    /// still ran when the restore began. A writer stalled between its revocation check and its
    /// call can still land a write after both passes; None skips it, for a restorer that is the
    /// writer itself.
    pub late_pass_after: Option<Duration>,
}

impl Context {
    /// The context for a real restore, now.
    pub fn current(hearth_version: Option<String>) -> Context {
        let clock = Clock::current();
        Context {
            now_ms: clock.now_ms,
            boot_time_ms: clock.now_ms.saturating_sub(clock.ticks_ms),
            ticks_ms: clock.ticks_ms,
            hearth_version,
            lock_wait: Duration::from_secs(2),
            second_pass_after: Some(Duration::from_secs(1)),
            late_pass_after: Some(Duration::from_secs(4)),
        }
    }

    fn clock(&self) -> Clock {
        Clock {
            now_ms: self.now_ms,
            ticks_ms: self.ticks_ms,
        }
    }
}

/// How a journal relates to this run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Current,
    /// Another Hearth version or schema: un-hide and reset DWM attributes only, no placements.
    OtherVersion,
    /// Another boot: its window handles mean nothing now, so its entries are dropped untouched.
    OtherBoot,
}

/// How far past the restorer's own tick count a journal's may be and still be this boot's. A
/// writer may land a journal after the restorer read the clock (while it waits for the mutex,
/// say), so a journal a little ahead is the normal case, never a sign of another boot.
pub const SAME_BOOT_SLACK_MS: u64 = 60_000;

pub fn origin(journal: &Journal, ctx: &Context) -> Origin {
    // The tick count restarts only when Windows does, so a journal written at a later tick than
    // now is from an earlier boot. The wall clock can't say this: it moves with every correction.
    // A wrong "same boot" is harmless, since the identity check refuses every window of another
    // boot; a wrong "other boot" would drop windows Nook still owes, which is why the slack
    // leans the other way.
    if journal.ticks > ctx.ticks_ms.saturating_add(SAME_BOOT_SLACK_MS) {
        return Origin::OtherBoot;
    }
    let other_version = ctx
        .hearth_version
        .as_deref()
        .is_some_and(|v| v != journal.hearth_version);
    if journal.v != SCHEMA || other_version {
        return Origin::OtherVersion;
    }
    Origin::Current
}

#[derive(Debug, Default)]
pub struct Report {
    /// Windows that passed the identity check and were put back without an error.
    pub restored: usize,
    /// Journaled windows that are gone or now someone else's; nothing was written to them.
    pub skipped: usize,
    pub failed: Vec<(crate::placement::Hwnd, crate::desktop::DesktopError)>,
    /// Set when the journal was lost, unreadable or from another boot: how many marked windows
    /// the sweep found.
    pub swept: Option<usize>,
    /// The journal came from another boot and its entries were dropped.
    pub dropped: bool,
    /// The journal came from another version and was restored conservatively.
    pub conservative: bool,
    /// Writes the second pass had to repeat.
    pub second_pass_fixes: usize,
    /// Writes the late pass had to repeat, when it ran.
    pub late_pass_fixes: Option<usize>,
    /// Whether the journal mutex was held; false means it was busy past the wait.
    pub locked: bool,
    pub journal_error: Option<String>,
}

/// Puts back every window the journal names, by `reason`'s policy. `desktop` must be in
/// Restoring mode (an Observing one makes it a dry run that writes nothing).
pub fn restore_all(
    desktop: &dyn Desktop,
    store: &Store,
    signals: &dyn Signals,
    ctx: &Context,
    reason: Reason,
) -> Report {
    let mut report = Report::default();
    // The event first: it stops a live window manager at its next write, before this restorer
    // even waits for the mutex the window manager might be holding.
    let fence = next_epoch(Some(signals.epoch()), ctx.now_ms);
    signals.revoke(fence);
    let held = Held::take(signals, ctx.lock_wait);
    report.locked = held.is_some();

    let mut journal = match store.load() {
        Loaded::Found(journal) => journal,
        Loaded::Missing => {
            // Nothing was journaled, or the journal was lost: the markers say what Nook touched.
            // The sweep finds nothing in a logon where Nook never marked a window, and only a
            // window it couldn't put back makes a journal appear, so the next restorer retries.
            let owed = steps::sweep(desktop, &mut report);
            if !owed.is_empty() {
                let mut fresh = fresh(ctx, owed);
                finish(&mut fresh, fence, reason, ctx, store, &mut report);
            }
            drop(held);
            signals.finished();
            return report;
        }
        Loaded::Corrupt(why) => {
            report.journal_error = Some(why);
            store.keep_bad_copy();
            let owed = steps::sweep(desktop, &mut report);
            let mut fresh = fresh(ctx, owed);
            finish(&mut fresh, fence, reason, ctx, store, &mut report);
            if !report.locked {
                reassert(store, &mut fresh, ctx, &mut report);
            }
            drop(held);
            signals.finished();
            return report;
        }
    };

    let epoch = next_epoch(Some(journal.epoch.max(fence)), ctx.now_ms);
    signals.revoke(epoch);
    journal.epoch = epoch;
    let origin = origin(&journal, ctx);
    if origin == Origin::OtherBoot {
        // Its handles name nothing of this boot's. Any window that carries Nook's marker is this
        // boot's, so the sweep still puts it back rather than the journal being cleared blind.
        report.dropped = true;
        journal.windows = steps::sweep(desktop, &mut report);
        finish(&mut journal, epoch, reason, ctx, store, &mut report);
        if !report.locked {
            reassert(store, &mut journal, ctx, &mut report);
        }
        drop(held);
        signals.finished();
        return report;
    }
    report.conservative = origin == Origin::OtherVersion;
    let writer_running = !journal.state.is_clean()
        && journal.pid != 0
        && desktop.process_start(journal.pid) == Some(journal.proc_start);
    journal.state = State::Restoring;
    save(store, &mut journal, ctx, &mut report);

    let policy = match origin {
        Origin::Current => reason.policy(),
        _ => Policy::Keep,
    };
    let plan = steps::first_pass(desktop, &mut journal, policy, reason, &mut report);
    finish(&mut journal, epoch, reason, ctx, store, &mut report);
    // The mutex goes back before the wait, so a new window manager is never held up by it.
    drop(held);
    let unguarded = !report.locked;
    if unguarded {
        reassert(store, &mut journal, ctx, &mut report);
    }

    if let Some(after) = ctx.second_pass_after {
        std::thread::sleep(after);
        report.second_pass_fixes = steps::second_pass(desktop, &plan, &mut report);
        if unguarded {
            reassert(store, &mut journal, ctx, &mut report);
        }
    }
    // Done only now: the installer ends Hearth as soon as its CLI hears Done, and the guard
    // stops watching, so neither may happen before the second pass.
    signals.finished();
    if let (Some(after), true) = (ctx.late_pass_after, writer_running) {
        std::thread::sleep(after);
        report.late_pass_fixes = Some(steps::second_pass(desktop, &plan, &mut report));
    }
    report
}

/// A journal written from scratch, for windows a sweep found it couldn't put back.
fn fresh(ctx: &Context, windows: Vec<WindowEntry>) -> Journal {
    Journal {
        v: SCHEMA,
        hearth_version: ctx.hearth_version.clone().unwrap_or_default(),
        boot_time: ctx.boot_time_ms,
        windows,
        ..Journal::default()
    }
}

fn save(store: &Store, journal: &mut Journal, ctx: &Context, report: &mut Report) {
    stamp(journal, ctx.clock());
    if let Err(e) = store.save(journal) {
        // The windows matter more than the record: the restore goes on, and the log says why
        // the journal may still read dirty.
        report.journal_error = Some(e.to_string());
    }
}

/// Without the mutex, a window manager's journal write that began before the revoke can still
/// land after this restorer's. It carries a lower epoch, so this restorer's journal is written
/// again over it; a restorer that came later (a higher epoch) is left alone.
fn reassert(store: &Store, journal: &mut Journal, ctx: &Context, report: &mut Report) {
    match store.load() {
        Loaded::Found(on_disk) if on_disk.epoch >= journal.epoch => {}
        _ => save(store, journal, ctx, report),
    }
}

/// Step 7: the journal reads clean (or clean-for-update, or session-ending), owing nothing but
/// the windows this restore couldn't put back.
fn finish(
    journal: &mut Journal,
    epoch: u64,
    reason: Reason,
    ctx: &Context,
    store: &Store,
    report: &mut Report,
) {
    journal.epoch = epoch;
    journal.ring = None;
    journal.appbars.clear();
    journal.resume = reason == Reason::Update;
    journal.state = match reason {
        Reason::Update => State::CleanForUpdate,
        Reason::SessionEnd => State::SessionEnding,
        _ => State::Clean,
    };
    // An update keeps the window list so the next version can re-adopt the same windows where
    // they are; a session end keeps it for the restore that follows the next start. Any other
    // restore keeps only the windows it couldn't put back, so the next restorer tries again.
    if !matches!(reason, Reason::Update | Reason::SessionEnd) {
        journal.windows.retain(WindowEntry::owes);
    }
    if reason.unclean() {
        journal.note_unclean(ctx.now_ms);
    }
    store.tidy();
    save(store, journal, ctx, report);
}
