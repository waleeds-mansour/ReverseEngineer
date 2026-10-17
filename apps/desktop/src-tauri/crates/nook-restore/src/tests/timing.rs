// What timing can do to a restore, made exact with FakeDesktop's hooks: a minimize that waits
// behind a busy app and lands after the first pass, a window manager preempted between its check
// and its call, and a journal write that began before the revoke and lands after the restore's.

use super::support::*;
use crate::desktop::fake::{Change, FakeSignals};
use crate::desktop::{Desktop, Mode};
use crate::journal::{Journal, Loaded, State};
use crate::objects::Signals;
use crate::placement::Placement;
use crate::recover::{restore_all, Reason};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Hook = Box<dyn Fn() + Send + Sync>;

/// FakeSignals with something to run when the restorer gives the journal mutex back (after its
/// first pass) and when it says Done, and optionally no mutex to take at all.
struct Hooked {
    inner: FakeSignals,
    mutex: bool,
    on_unlock: Hook,
    on_finished: Hook,
}

impl Hooked {
    fn new(inner: FakeSignals) -> Hooked {
        Hooked {
            inner,
            mutex: true,
            on_unlock: Box::new(|| {}),
            on_finished: Box::new(|| {}),
        }
    }
}

impl Signals for Hooked {
    fn revoke(&self, epoch: u64) {
        self.inner.revoke(epoch)
    }
    fn is_revoked(&self, epoch: u64) -> bool {
        self.inner.is_revoked(epoch)
    }
    fn epoch(&self) -> u64 {
        self.inner.epoch()
    }
    fn begin(&self, epoch: u64) {
        self.inner.begin(epoch)
    }
    fn lock_journal(&self, timeout: Duration) -> bool {
        self.mutex && self.inner.lock_journal(timeout)
    }
    fn unlock_journal(&self) {
        self.inner.unlock_journal();
        (self.on_unlock)();
    }
    fn finished(&self) {
        self.inner.finished();
        (self.on_finished)();
    }
}

fn journal(dir: &TempDir) -> Journal {
    match dir.store().load() {
        Loaded::Found(journal) => journal,
        other => panic!("expected a journal, got {other:?}"),
    }
}

fn placements_by(world: &crate::desktop::fake::FakeDesktop, by: &str) -> usize {
    let writes = world.writes().into_iter().filter(|w| w.by == by);
    writes
        .filter(|w| matches!(w.change, Change::Placement(_)))
        .count()
}

#[test]
fn keeping_positions_still_unhides_a_window_whose_minimize_landed_late() {
    let dir = TempDir::new("busy");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    // Code's app is busy: Nook's asynchronous minimize waits in its queue, so the window still
    // reads as shown when the restore starts.
    world.set_busy(CODE, true);
    wm.hide(CODE).unwrap();
    assert!(!world.window(CODE).unwrap().placement.is_minimized());

    let mut signals = Hooked::new(wm.signals.clone());
    let late = world.clone();
    // The app gets to its queue right after the first pass: the minimize lands then.
    signals.on_unlock = Box::new(move || late.set_busy(CODE, false));
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &signals,
        &ctx(),
        Reason::Disable,
    );
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(report.second_pass_fixes, 1);
    let code = world.window(CODE).unwrap();
    assert!(code.visible && !code.placement.is_minimized());
    assert_eq!(code.placement.normal_position, TILE_RIGHT);
    // The first pass had nothing to un-hide yet; only the second pass placed the window.
    assert_eq!(placements_by(&world, "restorer"), 1);
    assert_eq!(world.finished_count(), 1);
}

#[test]
fn done_comes_only_after_the_second_pass() {
    let dir = TempDir::new("done-after");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    // A border the second pass sets again, so the second pass always writes.
    wm.color(CHROME, 0x00FF_8800).unwrap();
    let mut signals = Hooked::new(wm.signals.clone());
    let seen = Arc::new(Mutex::new(None));
    let (watch, record) = (world.clone(), seen.clone());
    signals.on_finished = Box::new(move || {
        *record.lock().unwrap() = Some(watch.writes_by("restorer"));
    });
    restore_all(
        &restorer(&world),
        &dir.store(),
        &signals,
        &ctx(),
        Reason::User,
    );
    // Every write the restore made, both passes, had landed when Done was set.
    assert_eq!(*seen.lock().unwrap(), Some(world.writes_by("restorer")));
}

#[test]
fn the_late_pass_puts_back_a_write_that_slipped_between_check_and_call() {
    let dir = TempDir::new("gap");
    let world = world();
    let before = snapshot(&world);
    // The window manager still runs: it is stalled, not dead.
    world.add_process(WM_PID, WM_START);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();

    let (done_tx, done_rx) = mpsc::channel::<()>();
    let (report_tx, report_rx) = mpsc::channel();
    let (store, inner, restore_world) = (dir.store(), wm.signals.clone(), world.clone());
    // The window manager has passed its check for its next move, and is preempted there. A
    // restorer runs to Done meanwhile; then the move lands.
    world.gap_once("wm", move || {
        std::thread::spawn(move || {
            let mut signals = Hooked::new(inner);
            let done = Mutex::new(done_tx);
            signals.on_finished = Box::new(move || {
                let _ = done.lock().unwrap().send(());
            });
            let mut slow = ctx();
            slow.late_pass_after = Some(Duration::from_millis(1500));
            let restorer = restore_world.handle(Mode::Restoring, "restorer");
            let report = restore_all(&restorer, &store, &signals, &slow, Reason::User);
            let _ = report_tx.send(report);
        });
        done_rx.recv_timeout(Duration::from_secs(30)).unwrap();
    });
    let tile = Placement::normal(TILE_RIGHT).quiet();
    assert!(wm.desk.set_placement(CHROME, &tile).is_ok());
    assert_eq!(
        world.window(CHROME).unwrap().placement.normal_position,
        TILE_RIGHT
    );

    let report = report_rx.recv_timeout(Duration::from_secs(30)).unwrap();
    assert_eq!(report.late_pass_fixes, Some(1));
    assert_eq!(snapshot(&world), before);
}

#[test]
fn without_the_mutex_a_late_journal_write_is_written_over_again() {
    let dir = TempDir::new("reassert");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.color(CHROME, 0x00FF_8800).unwrap();
    // What the window manager was writing when the revoke came: its own epoch, still active.
    let stale = journal(&dir);

    // The first pass makes three writes to Chrome (place, border, marker); the second pass's
    // border write is the fourth. A journal write that began before the revoke lands there.
    let store = dir.store();
    world.gap_after("restorer", 3, move || store.save(&stale).unwrap());
    let mut signals = Hooked::new(wm.signals.clone());
    signals.mutex = false;
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &signals,
        &ctx(),
        Reason::User,
    );
    assert!(!report.locked);
    assert!(report.journal_error.is_none());
    let after = journal(&dir);
    assert_eq!(after.state, State::Clean);
    assert!(after.epoch > wm.writer.epoch());
}
