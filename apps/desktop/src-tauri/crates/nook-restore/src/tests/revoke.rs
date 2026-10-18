use super::support::*;
use crate::desktop::fake::FakeDesktop;
use crate::desktop::{Desktop, DesktopError, Mode, BORDER_DEFAULT};
use crate::placement::{Hwnd, Placement};
use crate::recover::{restore_all, Reason};
use std::sync::mpsc;
use std::time::Duration;

/// Every kind of write, so a test can show that none gets through.
fn every_write(desk: &dyn Desktop, hwnd: Hwnd) -> Vec<Result<(), DesktopError>> {
    vec![
        desk.set_placement(hwnd, &Placement::normal(TILE_RIGHT).quiet()),
        desk.show_no_activate(hwnd),
        desk.uncloak(hwnd),
        desk.set_marker(hwnd, 1),
        desk.remove_marker(hwnd),
        desk.set_border_color(hwnd, 0x00FF_0000),
        desk.set_transitions_disabled(hwnd, true),
        desk.remove_appbar(hwnd),
    ]
}

/// The writes that landed after the first revoke, by `who`.
fn landed_after_revoke(world: &FakeDesktop, who: &str) -> usize {
    let from = world.revoked_after().expect("a restore revoked");
    let writes = world.writes();
    writes[from..].iter().filter(|w| w.by == who).count()
}

#[test]
fn observing_writes_nothing() {
    let world = world();
    let observer = world.handle(Mode::Observing, "panel");
    for result in every_write(&observer, CHROME) {
        assert_eq!(result, Err(DesktopError::ReadOnly));
    }
    assert!(world.writes().is_empty());
    assert_eq!(world.refused_by("panel"), 8);
}

#[test]
fn revocation_gives_zero_writes_after_revoke() {
    let dir = TempDir::new("revoke");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    assert!(world.writes_by("wm") > 0);
    restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::Panic,
    );

    for result in every_write(&wm.desk, CHROME) {
        assert_eq!(result, Err(DesktopError::Revoked));
    }
    // The journal refuses too, so the window manager can't even start its next change.
    assert!(wm.adopt(CODE, TILE_RIGHT).is_err());
    assert_eq!(world.window(CODE).unwrap().marker, None);
    assert_eq!(landed_after_revoke(&world, "wm"), 0);
}

#[test]
fn a_stalled_window_manager_writes_nothing_after_a_restore() {
    let dir = TempDir::new("stalled");
    let world = world();
    let before = snapshot(&world);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    let signals = wm.signals.clone();

    // The window manager starts a layout pass, then stalls in the middle of it (the design's
    // test delays it 3 s; a channel makes the stall exact without the wait).
    let (stalled, stall) = mpsc::channel::<()>();
    let (resume, resumed) = mpsc::channel::<()>();
    let desk = wm.desk.clone();
    let pass = std::thread::spawn(move || {
        let first = desk.set_placement(CHROME, &Placement::normal(TILE_RIGHT).quiet());
        stalled.send(()).unwrap();
        resumed.recv().unwrap();
        let rest = [
            desk.set_placement(CODE, &Placement::normal(TILE_LEFT).quiet()),
            desk.set_border_color(CODE, 0x0000_FF00),
            desk.set_marker(CHROME, 3),
        ];
        (first, rest)
    });
    stall.recv().unwrap();
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &signals,
        &ctx(),
        Reason::Guard,
    );
    assert!(report.failed.is_empty());
    resume.send(()).unwrap();

    let (first, rest) = pass.join().unwrap();
    assert_eq!(first, Ok(()));
    assert_eq!(rest, [Err(DesktopError::Revoked); 3]);
    assert_eq!(landed_after_revoke(&world, "wm"), 0);
    assert_eq!(snapshot(&world), before);
    assert_eq!(world.window(CODE).unwrap().border, BORDER_DEFAULT);
}

#[test]
fn a_racing_window_manager_never_lands_a_write_after_revoke() {
    let dir = TempDir::new("race");
    let world = world();
    let before = snapshot(&world);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    let signals = wm.signals.clone();
    let desk = wm.desk.clone();
    let racer = std::thread::spawn(move || {
        let tiles = [TILE_LEFT, TILE_RIGHT];
        for i in 0..5000 {
            let tile = Placement::normal(tiles[i % 2]).quiet();
            if desk.set_placement(CHROME, &tile) == Err(DesktopError::Revoked) {
                return i;
            }
            std::thread::sleep(Duration::from_micros(200));
        }
        usize::MAX
    });
    std::thread::sleep(Duration::from_millis(20));
    restore_all(
        &restorer(&world),
        &dir.store(),
        &signals,
        &ctx(),
        Reason::Panic,
    );
    let stopped_at = racer.join().unwrap();
    assert!(
        stopped_at < usize::MAX,
        "the window manager was never stopped"
    );
    assert_eq!(landed_after_revoke(&world, "wm"), 0);
    assert_eq!(snapshot(&world), before);
}

#[test]
fn a_new_run_after_a_restore_does_not_unfence_the_old_one() {
    let dir = TempDir::new("unfence");
    let world = world();
    let mut old = Wm::start(&world, dir.store());
    old.adopt(CHROME, TILE_LEFT).unwrap();
    restore_all(
        &restorer(&world),
        &dir.store(),
        &old.signals,
        &ctx(),
        Reason::User,
    );

    // The owner turns Nook back on: the new run clears Revoked for itself only.
    let mut new = Wm::start(&world, dir.store());
    assert!(new.writer.epoch() > old.writer.epoch());
    new.adopt(CODE, TILE_RIGHT).unwrap();
    for result in every_write(&old.desk, CHROME) {
        assert_eq!(result, Err(DesktopError::Revoked));
    }
    assert!(old.adopt(NOTES, TILE_RIGHT).is_err());
    assert_eq!(world.window(NOTES).unwrap().marker, None);
}
