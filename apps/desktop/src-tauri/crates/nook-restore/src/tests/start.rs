use super::support::*;
use crate::journal::{Loaded, State};
use crate::recover::{at_start, restore_all, Reason, Start, RESUME_WITHIN_MS};

fn state(dir: &TempDir) -> State {
    match dir.store().load() {
        Loaded::Found(journal) => journal.state,
        other => panic!("expected a journal, got {other:?}"),
    }
}

#[test]
fn a_same_boot_dirty_journal_is_restored_at_start() {
    let dir = TempDir::new("start-dirty");
    let world = world();
    let before = snapshot(&world);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    wm.color(CHROME, 0x0000_88FF).unwrap();
    wm.hide(CODE).unwrap();
    // Hearth dies here: its process is gone, the journal still reads 'active'.
    drop(wm);

    let outcome = at_start(&restorer(&world), &dir.store(), &world.signals(), &ctx());
    let Start::Restored(report) = outcome else {
        panic!("expected a restore, got {outcome:?}");
    };
    assert_eq!(report.restored, 2);
    assert!(report.failed.is_empty() && !report.dropped);
    assert_eq!(snapshot(&world), before);
    assert_eq!(state(&dir), State::Clean);
    let Loaded::Found(journal) = dir.store().load() else {
        unreachable!()
    };
    assert_eq!(journal.unclean, vec![NOW]);
}

#[test]
fn a_journal_whose_writer_still_runs_is_left_alone() {
    let dir = TempDir::new("start-alive");
    let world = world();
    world.add_process(WM_PID, WM_START);
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    let outcome = at_start(&restorer(&world), &dir.store(), &world.signals(), &ctx());
    assert!(matches!(outcome, Start::WriterAlive), "{outcome:?}");
    assert_eq!(world.writes_by("restorer"), 0);
    assert_eq!(state(&dir), State::Active);
}

/// The context of a start after Windows restarted: its tick count began again.
fn rebooted() -> crate::recover::Context {
    let mut rebooted = ctx();
    rebooted.ticks_ms = 60_000;
    rebooted.boot_time_ms = NOW + 86_400_000 - 60_000;
    rebooted.now_ms = NOW + 86_400_000;
    rebooted
}

#[test]
fn a_journal_from_another_boot_is_dropped_without_a_write() {
    let dir = TempDir::new("start-boot");
    let mut wm = Wm::start(&world(), dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.hide(CHROME).unwrap();
    drop(wm);

    // After the restart the same handles name other windows, none of them marked. Even a live
    // process with the writer's pid and start time means nothing now.
    let world = world();
    world.add_process(WM_PID, WM_START);
    let outcome = at_start(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &rebooted(),
    );
    let Start::Restored(report) = outcome else {
        panic!("expected the journal dropped, got {outcome:?}");
    };
    assert!(report.dropped);
    assert_eq!(report.swept, Some(0));
    assert_eq!(world.writes_by("restorer"), 0);
    let Loaded::Found(journal) = dir.store().load() else {
        unreachable!()
    };
    assert_eq!(journal.state, State::Clean);
    assert!(journal.windows.is_empty());
    // A later restore has nothing left to do with those handles.
    restore_all(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &rebooted(),
        Reason::User,
    );
    assert_eq!(world.writes_by("restorer"), 0);
}

#[test]
fn a_window_still_marked_after_an_other_boot_verdict_is_swept_back() {
    // Should the verdict ever be wrong, the windows aren't cleared blind: any window carrying
    // Nook's marker is this boot's, and the sweep un-hides it.
    let dir = TempDir::new("start-boot-marked");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.hide(CHROME).unwrap();
    drop(wm);

    let outcome = at_start(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &rebooted(),
    );
    let Start::Restored(report) = outcome else {
        panic!("expected a sweep, got {outcome:?}");
    };
    assert!(report.dropped && report.failed.is_empty());
    assert_eq!((report.swept, report.restored), (Some(1), 1));
    let chrome = world.window(CHROME).unwrap();
    assert!(chrome.visible && !chrome.placement.is_minimized() && chrome.marker.is_none());
    assert_eq!(state(&dir), State::Clean);
}

#[test]
fn a_fresh_update_resumes_and_a_stale_one_does_not() {
    let dir = TempDir::new("start-update");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    restore_all(
        &restorer(&world),
        &dir.store(),
        &wm.signals,
        &ctx(),
        Reason::Update,
    );
    assert_eq!(state(&dir), State::CleanForUpdate);

    // The new version starts a moment later and takes the same windows back where they are.
    let mut updated = ctx();
    updated.hearth_version = Some("1.3.0".into());
    updated.now_ms = NOW + 60_000;
    match at_start(&restorer(&world), &dir.store(), &world.signals(), &updated) {
        Start::Resume(journal) => assert_eq!(journal.windows[0].hwnd, CHROME),
        other => panic!("expected a resume, got {other:?}"),
    }
    updated.now_ms = NOW + RESUME_WITHIN_MS + 1;
    let outcome = at_start(&restorer(&world), &dir.store(), &world.signals(), &updated);
    assert!(matches!(outcome, Start::Nothing), "{outcome:?}");
}

#[test]
fn a_clean_or_missing_journal_means_nothing_to_do() {
    let dir = TempDir::new("start-clean");
    let world = world();
    let outcome = at_start(&restorer(&world), &dir.store(), &world.signals(), &ctx());
    assert!(matches!(outcome, Start::Nothing));
    let wm = Wm::start(&world, dir.store());
    drop(wm);
    restore_all(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &ctx(),
        Reason::Quit,
    );
    let outcome = at_start(&restorer(&world), &dir.store(), &world.signals(), &ctx());
    assert!(matches!(outcome, Start::Nothing));
    assert!(world.writes().is_empty());
}
