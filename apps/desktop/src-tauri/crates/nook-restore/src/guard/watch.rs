// The guard's watch (docs/nook-wm.md, "The guard runs"). It sleeps in one WaitForMultipleObjects
// on Hearth's process and the shared events. Disarmed, nothing is journaled and the wait has no
// timeout, so the guard never wakes at all. Armed, it wakes once per beat period and reads the
// heartbeat counter; when the counter stands still for MISSED_BEATS periods the window manager is
// wedged, and the guard revokes it and restores. Hearth ending, for any reason, also restores,
// unless the journal already owes nothing.

use super::spawn::{open_parent, Process};
use super::{Options, MISSED_BEATS, RESTORE_GRACE};
use crate::cli::{default_dir, exit_code};
use crate::desktop::real::RealDesktop;
use crate::journal::{Loaded, Store};
use crate::objects::session::{session_tag, Kind, SessionObjects};
use crate::objects::{Signals, Unshared};
use crate::recover::{restore_all, Context, Reason};
use std::time::Duration;
use windows::Win32::Foundation::{HANDLE, WAIT_TIMEOUT};
use windows::Win32::System::Threading::{WaitForMultipleObjects, INFINITE};

/// Why the watch ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ending {
    /// Hearth ended, or was already gone when the guard started.
    ParentGone,
    /// Armed, and the heartbeat stood still for MISSED_BEATS periods.
    Wedged,
    /// A restore was asked for and the app didn't finish it within RESTORE_GRACE.
    Requested(Reason),
    /// A restore finished elsewhere: the app quit cleanly, turned Nook off or prepared an update.
    Done,
}

enum Woke {
    Object(usize),
    Timeout,
    Failed,
}

fn wait(handles: &[HANDLE], ms: u32) -> Woke {
    let got = unsafe { WaitForMultipleObjects(handles, false, ms) };
    match got.0 as usize {
        // WAIT_OBJECT_0 is 0. Events and processes are never abandoned, so nothing else counts.
        i if i < handles.len() => Woke::Object(i),
        _ if got == WAIT_TIMEOUT => Woke::Timeout,
        _ => Woke::Failed,
    }
}

fn millis(period: Duration) -> u32 {
    // u32::MAX is INFINITE; a period must stay below it.
    period.as_millis().min(u128::from(u32::MAX - 1)) as u32
}

/// The guard's whole life: watch, then restore if that is what the ending calls for.
pub fn run(options: &Options) -> i32 {
    let store = Store::in_dir(&options.nook_dir.clone().unwrap_or_else(default_dir));
    let tag = options.tag.clone().unwrap_or_else(session_tag);
    let parent = open_parent(options.parent);
    let Ok(objects) = SessionObjects::create(&tag) else {
        // Another program holds one of the names, so there is no heartbeat or request to see.
        // Hearth ending is still worth waiting for.
        if let Some(parent) = &parent {
            let _ = wait(&[parent.handle()], INFINITE);
        }
        return restore(&store, &Unshared, options, Reason::Guard, true);
    };
    // A Done left by an earlier restore (Nook was off before this guard) is not this one's end.
    objects.clear_done();
    match watch(&objects, parent.as_ref(), options) {
        Ending::Done => 0,
        Ending::ParentGone => restore(&store, &objects, options, Reason::Guard, true),
        // A wedged window manager is revoked even if the journal owes nothing, so it can't
        // wake up later and change windows with no guard watching.
        Ending::Wedged => restore(&store, &objects, options, Reason::Guard, false),
        Ending::Requested(reason) => restore(&store, &objects, options, reason, true),
    }
}

/// Waits until something calls for the guard. Never wakes while disarmed; wakes once per beat
/// period while armed.
pub fn watch(objects: &SessionObjects, parent: Option<&Process>, options: &Options) -> Ending {
    let Some(parent) = parent else {
        return Ending::ParentGone;
    };
    let restore = objects.handle(Kind::Restore);
    let done = objects.handle(Kind::Done);
    let armed = objects.handle(Kind::Armed);
    // The beat count last seen, and how many periods in a row it stood still.
    let mut seen: Option<(u64, u32)> = None;
    loop {
        let woke = if objects.is_armed() {
            seen.get_or_insert((objects.beats(), 0));
            // Armed stays set while armed, so it leaves the wait or the wait would never sleep.
            wait(&[parent.handle(), restore, done], millis(options.beat))
        } else {
            seen = None;
            wait(&[parent.handle(), restore, done, armed], INFINITE)
        };
        match woke {
            Woke::Object(0) => return Ending::ParentGone,
            Woke::Object(1) => return answer(objects, parent),
            Woke::Object(2) => return Ending::Done,
            // Armed: the next turn starts counting beats.
            Woke::Object(_) => {}
            Woke::Timeout => {
                let now = objects.beats();
                let (last, missed) = seen.get_or_insert((now, 0));
                if now != *last {
                    (*last, *missed) = (now, 0);
                } else {
                    *missed += 1;
                    if *missed >= MISSED_BEATS {
                        return Ending::Wedged;
                    }
                }
            }
            // A handle went bad and the guard can't watch any more; restoring is always safe.
            Woke::Failed => return Ending::ParentGone,
        }
    }
}

/// Someone asked for a restore. The app answers it (it may resume after an update), so the guard
/// waits for it to finish, and restores on its own only if it doesn't.
fn answer(objects: &SessionObjects, parent: &Process) -> Ending {
    let reason = objects.requested_reason();
    let done = objects.handle(Kind::Done);
    match wait(&[done, parent.handle()], millis(RESTORE_GRACE)) {
        Woke::Object(0) => Ending::Done,
        _ => Ending::Requested(reason),
    }
}

/// Runs the shared restore. With `if_owed`, a journal that owes nothing (the app put everything
/// back before it ended, or left the windows for an update to re-adopt) means no write at all.
fn restore(
    store: &Store,
    signals: &dyn Signals,
    options: &Options,
    reason: Reason,
    if_owed: bool,
) -> i32 {
    if if_owed {
        if let Loaded::Found(journal) = store.load() {
            if !journal.owes_restore() {
                return 0;
            }
        }
    }
    let ctx = Context::current(options.hearth_version.clone());
    let report = restore_all(&RealDesktop::restoring(), store, signals, &ctx, reason);
    crate::log::restored(store.dir(), "guard", &report);
    exit_code(report.failed.len())
}
