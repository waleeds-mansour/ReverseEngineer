// A window a restore couldn't put back stays owed: its journal entry and its marker stay, a new
// run can't claim the journal over it, and the next start tries again. Windows refuse writes to
// an elevated app's window, which FakeDesktop's deny models.

use super::support::*;
use crate::journal::{Hidden, Journal, Loaded, State, WriteError, Writer};
use crate::recover::{at_start, restore_all, Reason, Start};

fn journal(dir: &TempDir) -> Journal {
    match dir.store().load() {
        Loaded::Found(journal) => journal,
        other => panic!("expected a journal, got {other:?}"),
    }
}

fn second_run(dir: &TempDir, world: &crate::desktop::fake::FakeDesktop) -> Result<Writer, String> {
    let mut journal = Journal::new(VERSION, "two".into(), 101, 1_001, BOOT);
    Writer::claim(dir.store(), &world.signals(), &mut journal, CLOCK).map_err(|e| match e {
        WriteError::Dirty(why) => why,
        other => other.to_string(),
    })
}

#[test]
fn a_window_that_refused_keeps_its_entry_and_its_marker_until_it_is_put_back() {
    let dir = TempDir::new("owed");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    wm.color(CHROME, 0x00FF_8800).unwrap();
    wm.hide(CODE).unwrap();
    drop(wm);

    world.deny(CODE, true);
    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &ctx(),
        Reason::User,
    );
    assert_eq!(report.restored, 1);
    assert!(report.failed.iter().all(|(h, _)| *h == CODE));
    let after = journal(&dir);
    assert_eq!(after.state, State::Clean);
    assert_eq!(after.windows.len(), 1, "only the window still owed");
    assert_eq!(after.windows[0].hwnd, CODE);
    assert_eq!(after.windows[0].hidden, Some(Hidden::Minimized));
    assert!(after.owes_restore());
    assert!(world.window(CODE).unwrap().marker.is_some());
    assert!(world.window(CHROME).unwrap().marker.is_none());

    // No new run may take the journal over while it lists a window that is still hidden.
    assert_eq!(
        second_run(&dir, &world).err().as_deref(),
        Some("windows still owed")
    );

    // The window can be written to again (the elevated app ended its elevated session, say):
    // the next start tries again and keeps the window where it is.
    world.deny(CODE, false);
    let outcome = at_start(&restorer(&world), &dir.store(), &world.signals(), &ctx());
    let Start::Retried(report) = outcome else {
        panic!("expected another try, got {outcome:?}");
    };
    assert_eq!((report.restored, report.failed.len()), (1, 0));
    let code = world.window(CODE).unwrap();
    assert!(code.visible && !code.placement.is_minimized() && code.marker.is_none());
    assert_eq!(code.placement.normal_position, TILE_RIGHT);
    let after = journal(&dir);
    assert!(after.windows.is_empty() && !after.owes_restore());
    // A try again isn't Nook ending badly, so safe start doesn't count it.
    assert!(after.unclean.is_empty());
    assert!(second_run(&dir, &world).is_ok());
}

#[test]
fn the_sweep_journals_a_window_it_could_not_put_back() {
    for lost in ["missing", "corrupt"] {
        let dir = TempDir::new("owed-sweep");
        let world = world();
        let mut wm = Wm::start(&world, dir.store());
        wm.adopt(CHROME, TILE_LEFT).unwrap();
        wm.adopt(CODE, TILE_RIGHT).unwrap();
        wm.hide(CHROME).unwrap();
        wm.hide(CODE).unwrap();
        drop(wm);
        match lost {
            "missing" => std::fs::remove_file(dir.store().path()).unwrap(),
            _ => std::fs::write(dir.store().path(), b"{\"v\":2,").unwrap(),
        }

        world.deny(CODE, true);
        let report = restore_all(
            &restorer(&world),
            &dir.store(),
            &world.signals(),
            &ctx(),
            Reason::Guard,
        );
        assert_eq!((report.swept, report.restored), (Some(2), 1), "{lost}");
        assert!(world.window(CODE).unwrap().marker.is_some(), "{lost}");
        let owed = journal(&dir);
        assert_eq!(owed.windows.len(), 1, "{lost}");
        let entry = &owed.windows[0];
        assert_eq!(
            (entry.hwnd, entry.pid, entry.proc_start),
            (CODE, 300, 3_000)
        );
        assert_eq!(entry.hidden, Some(Hidden::Minimized), "{lost}");
        assert!(entry.transitions_disabled, "{lost}");

        world.deny(CODE, false);
        let outcome = at_start(&restorer(&world), &dir.store(), &world.signals(), &ctx());
        assert!(matches!(outcome, Start::Retried(_)), "{lost}: {outcome:?}");
        let code = world.window(CODE).unwrap();
        assert!(
            !code.placement.is_minimized() && code.marker.is_none(),
            "{lost}"
        );
        assert!(!journal(&dir).owes_restore(), "{lost}");
    }
}

#[test]
fn a_window_gone_or_reused_is_owed_nothing() {
    let dir = TempDir::new("owed-gone");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    wm.adopt(CHROME, TILE_LEFT).unwrap();
    wm.adopt(CODE, TILE_RIGHT).unwrap();
    wm.hide(CHROME).unwrap();
    wm.hide(CODE).unwrap();
    drop(wm);
    world.destroy(CHROME);
    // Code's process ended and a new one got its pid.
    world.end_process(300);
    world.add_process(300, 3_500);

    let report = restore_all(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &ctx(),
        Reason::User,
    );
    assert_eq!((report.restored, report.skipped), (0, 2));
    let after = journal(&dir);
    assert!(after.windows.is_empty() && !after.owes_restore());
}
