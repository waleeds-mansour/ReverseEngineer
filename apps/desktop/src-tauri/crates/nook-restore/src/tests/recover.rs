use super::support::*;
use crate::desktop::fake::{Change, FakeDesktop, FakeSignals, FakeWindow};
use crate::desktop::{Desktop, Mode, BORDER_DEFAULT};
use crate::journal::{HiddenBy, Loaded, State};
use crate::objects::Signals;
use crate::placement::{Hwnd, Placement, SW_HIDE, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED};
use crate::recover::{restore_all, Reason};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const PAINT: Hwnd = Hwnd(0x50);

fn journal(dir: &TempDir) -> crate::journal::Journal {
    match dir.store().load() {
        Loaded::Found(journal) => journal,
        other => panic!("expected a journal, got {other:?}"),
    }
}

fn placements_to(world: &crate::desktop::fake::FakeDesktop, by: &str, hwnd: Hwnd) -> usize {
    let writes = world.writes().into_iter();
    let to = writes.filter(|w| w.by == by && w.hwnd == hwnd);
    to.filter(|w| matches!(w.change, Change::Placement(_)))
        .count()
}

#[test]
fn maximized_and_minimized_originals_restore_exactly() {
    let dir = TempDir::new("originals");
    let world = world();
    world.add_window(
        PAINT,
        FakeWindow::new(400, "Paint", R_CODE)
            .maximized()
            .minimized(),
    );
    let paint = world.window(PAINT).unwrap();
    assert!(paint.placement.restores_maximized());
    let before = snapshot(&world);

    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.adopt(NOTES, TILE_RIGHT).unwrap();
    wm.adopt(MUSIC, TILE_LEFT).unwrap();
    wm.adopt(PAINT, TILE_RIGHT).unwrap();
    wm.hide(NOTES).unwrap();
    assert_ne!(snapshot(&world), before);

    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::User,
    );
    assert_eq!((report.restored, report.skipped), (4, 0));
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    assert_eq!(snapshot(&world), before);
    assert_eq!(world.window(PAINT), Some(paint));
    assert_eq!(
        world.window(NOTES).unwrap().placement.show_cmd,
        SW_SHOWMAXIMIZED
    );
    let after = journal(&dir);
    assert_eq!(after.state, State::Clean);
    assert!(after.windows.is_empty() && !after.resume);
    assert_eq!(world.finished_count(), 1);
}

#[test]
fn a_window_hidden_while_maximized_comes_back_maximized() {
    let dir = TempDir::new("keep");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    world.user_show(CODE, SW_SHOWMAXIMIZED);
    wm.hide(CODE).unwrap();
    assert!(world.window(CODE).unwrap().placement.is_minimized());

    // An update keeps positions: the window comes back maximized over its tile.
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::Update,
    );
    assert!(report.failed.is_empty());
    let code = world.window(CODE).unwrap();
    assert_eq!(code.placement.show_cmd, SW_SHOWMAXIMIZED);
    assert_eq!(code.placement.normal_position, TILE_RIGHT);
    assert!(code.visible && code.marker.is_none() && !code.transitions_disabled);
    let after = journal(&dir);
    assert_eq!(after.state, State::CleanForUpdate);
    assert!(after.resume);
    assert_eq!(after.windows.len(), 1);
    assert!(after.windows[0].hidden.is_none());
    assert!(after.unclean.is_empty());
}

#[test]
fn putting_back_the_originals_after_a_maximized_hide_ends_where_it_began() {
    let dir = TempDir::new("max-originals");
    let world = world();
    let before = snapshot(&world);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    world.user_show(CODE, SW_SHOWMAXIMIZED);
    wm.hide(CODE).unwrap();
    restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::Panic,
    );
    assert_eq!(snapshot(&world), before);
}

#[test]
fn a_corrupt_journal_falls_back_to_the_marker_sweep() {
    let dir = TempDir::new("sweep");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    wm.color(CHROME, 0x00FF_8800).unwrap();
    wm.hide(CODE).unwrap();
    std::fs::write(dir.store().path(), b"{\"v\":2,\"windows\":[{\"hwnd\":\"0x").unwrap();

    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::Guard,
    );
    assert_eq!(report.swept, Some(2));
    assert!(report.journal_error.is_some());
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let chrome = world.window(CHROME).unwrap();
    let code = world.window(CODE).unwrap();
    assert_eq!((chrome.border, chrome.marker), (BORDER_DEFAULT, None));
    assert!(!code.placement.is_minimized() && code.marker.is_none());
    // Without the journal the originals are unknown, so positions stay where Nook put them.
    assert_eq!(code.placement.normal_position, TILE_RIGHT);

    let fresh = journal(&dir);
    assert_eq!(fresh.state, State::Clean);
    assert_eq!(fresh.unclean, vec![NOW]);
    let mut bad = dir.store().path().as_os_str().to_owned();
    bad.push(".bad");
    assert!(std::path::Path::new(&bad).exists());
}

#[test]
fn another_version_journal_unhides_but_moves_nothing() {
    let dir = TempDir::new("version");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    wm.color(CHROME, 0x00FF_8800).unwrap();
    wm.hide(CODE).unwrap();

    let mut newer = ctx();
    newer.hearth_version = Some("2.0.0".into());
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &newer,
        Reason::User,
    );
    assert!(report.conservative);
    assert_eq!(placements_to(&world, "restorer", CHROME), 0);
    assert_eq!(placements_to(&world, "restorer", CODE), 1);
    let chrome = world.window(CHROME).unwrap();
    let code = world.window(CODE).unwrap();
    assert_eq!(chrome.placement.normal_position, TILE_LEFT);
    assert_eq!((chrome.border, chrome.marker), (BORDER_DEFAULT, None));
    assert!(!code.placement.is_minimized() && code.visible && code.marker.is_none());
}

#[test]
fn a_window_the_user_minimized_stays_minimized_with_its_old_place() {
    let dir = TempDir::new("user-min");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    world.user_show(CHROME, SW_SHOWMINIMIZED);
    restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::User,
    );
    let chrome = world.window(CHROME).unwrap();
    assert_eq!(chrome.placement.show_cmd, SW_SHOWMINIMIZED);
    assert_eq!(chrome.placement.normal_position, R_CHROME);
}

#[test]
fn a_window_its_app_hid_is_never_shown() {
    let dir = TempDir::new("app-hid");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    world.user_show(CHROME, SW_HIDE);
    restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::User,
    );
    let chrome = world.window(CHROME).unwrap();
    assert!(!chrome.visible && chrome.marker.is_none());
    assert_eq!(placements_to(&world, "restorer", CHROME), 0);
}

#[test]
fn a_tray_app_that_hid_after_nook_is_shown_again() {
    let dir = TempDir::new("tray");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.hide(CHROME).unwrap();
    world.user_show(CHROME, SW_HIDE);
    wm.journal.windows[0].hidden_by = Some(HiddenBy::AppAfterNook);
    wm.journal.windows[0].hidden = None;
    let mut journal = wm.journal.clone();
    wm.writer.write(&wm.signals, &mut journal, CLOCK).unwrap();
    restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::User,
    );
    let chrome = world.window(CHROME).unwrap();
    assert!(chrome.visible && !chrome.placement.is_minimized());
    assert_eq!(chrome.placement.normal_position, R_CHROME);
}

/// Signals that land a move the window manager queued before the revoke as the first pass
/// finishes, when the restorer gives the mutex back. A thread watching for the finish lost the
/// race to the second pass's timer when the test ran at below-normal priority on a busy machine
/// (1 of 7 runs).
struct LateMove {
    inner: FakeSignals,
    late: FakeDesktop,
    landed: AtomicBool,
}

impl Signals for LateMove {
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
        self.inner.lock_journal(timeout)
    }
    fn unlock_journal(&self) {
        self.inner.unlock_journal();
        let tile = Placement::normal(TILE_LEFT).quiet();
        let ok = self.late.set_placement(CHROME, &tile).is_ok();
        self.landed.store(ok, Ordering::SeqCst);
    }
    fn finished(&self) {
        self.inner.finished()
    }
}

#[test]
fn the_second_pass_puts_back_a_move_that_landed_late() {
    let dir = TempDir::new("late");
    let world = world();
    let before = snapshot(&world);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();

    let signals = LateMove {
        inner: wm.signals.clone(),
        late: world.handle(Mode::Restoring, "late"),
        landed: AtomicBool::new(false),
    };
    let mut slow = ctx();
    slow.second_pass_after = Some(Duration::from_millis(300));
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &signals,
        &slow,
        Reason::User,
    );
    assert!(signals.landed.load(Ordering::SeqCst));
    assert_eq!(report.second_pass_fixes, 1);
    assert_eq!(snapshot(&world), before);
}

#[test]
fn nothing_journaled_means_nothing_written() {
    let dir = TempDir::new("nothing");
    let world = world();
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &ctx(),
        Reason::User,
    );
    assert_eq!(report.swept, Some(0));
    assert!(world.writes().is_empty());
    assert!(!dir.store().path().exists());
    assert_eq!(world.finished_count(), 1);
}

#[test]
fn restoring_twice_changes_nothing_the_second_time() {
    let dir = TempDir::new("twice");
    let world = world();
    let before = snapshot(&world);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.hide(CHROME).unwrap();
    let r = restorer(&world);
    restore_all(&r, &dir.store(), &wm.signals, &ctx(), Reason::User);
    let writes = world.writes().len();
    let again = restore_all(&r, &dir.store(), &wm.signals, &ctx(), Reason::User);
    assert_eq!((again.restored, again.skipped), (0, 0));
    assert_eq!(world.writes().len(), writes);
    assert_eq!(snapshot(&world), before);
}

#[test]
fn a_window_nook_hid_goes_back_in_one_write() {
    // Windows loses a placement posted right behind an un-minimize (recover/steps.rs), so the
    // first pass un-hides and places each window with a single write, by either policy.
    for reason in [Reason::User, Reason::Update] {
        let dir = TempDir::new("one-write");
        let world = world();
        let mut wm = Wm::start(&world, dir.store());
        wm.adopt(CHROME, TILE_LEFT).unwrap();
        wm.adopt(NOTES, TILE_RIGHT).unwrap();
        wm.hide(CHROME).unwrap();
        wm.hide(NOTES).unwrap();
        let mut first_pass_only = ctx();
        first_pass_only.second_pass_after = None;
        let r = restorer(&world);
        let report = restore_all(&r, &dir.store(), &wm.signals, &first_pass_only, reason);
        assert!(report.failed.is_empty(), "{reason:?}: {:?}", report.failed);
        for hwnd in [CHROME, NOTES] {
            let writes = placements_to(&world, "restorer", hwnd);
            assert_eq!(writes, 1, "{reason:?}: placements to {hwnd}");
            let win = world.window(hwnd).unwrap();
            assert!(
                win.visible && !win.placement.is_minimized(),
                "{reason:?} {hwnd}"
            );
        }
    }
}
