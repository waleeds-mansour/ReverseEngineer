// The design's fault-injection test (docs/nook-wm.md, "Testing"): the window manager dies after
// k writes, for every k, and a restore must still leave every window as it was before Nook; so
// must a restorer that dies midway and the next one that finishes its job.

use super::support::*;
use crate::desktop::Mode;
use crate::recover::{restore_all, Reason};
use std::panic::{self, AssertUnwindSafe};
use std::sync::Once;

/// Injected faults are expected here; any other panic still reaches the test output.
fn quiet_injected_faults() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let message = info.payload().downcast_ref::<String>();
            if !message.is_some_and(|m| m.starts_with("injected fault")) {
                previous(info);
            }
        }));
    });
}

/// Adopt, colour and hide, including hiding a window that was maximized before Nook.
fn scenario(wm: &mut Wm) -> Result<(), String> {
    wm.adopt(CHROME, TILE_LEFT)?;
    wm.adopt(CODE, TILE_RIGHT)?;
    wm.adopt(NOTES, TILE_RIGHT)?;
    wm.color(CHROME, 0x00FF_8800)?;
    wm.hide(CODE)?;
    wm.hide(NOTES)?;
    Ok(())
}

fn writes_in_full_run(who: &str, restore: bool) -> usize {
    let dir = TempDir::new("fault-count");
    let world = world();
    let mut wm = Wm::start(&world, dir.store());
    scenario(&mut wm).unwrap();
    if restore {
        restore_all(
            &restorer(&world),
            &dir.store(),
            &wm.signals,
            &ctx(),
            Reason::Guard,
        );
    }
    world.writes_by(who)
}

fn untouched_music(world: &crate::desktop::fake::FakeDesktop) -> bool {
    world.writes().iter().all(|w| w.hwnd != MUSIC)
}

#[test]
fn a_window_manager_dying_after_any_write_leaves_nothing_changed() {
    quiet_injected_faults();
    let total = writes_in_full_run("wm", false);
    assert!(total >= 12, "{total}");
    for k in 0..=total {
        let dir = TempDir::new("fault-wm");
        let world = world();
        let before = snapshot(&world);
        let mut wm = Wm::start(&world, dir.store());
        world.fault_after("wm", Some(k));
        let died = panic::catch_unwind(AssertUnwindSafe(|| scenario(&mut wm))).is_err();
        assert_eq!(died, k < total, "k = {k}");
        world.fault_after("wm", None);

        let signals = world.signals();
        let report = restore_all(
            &restorer(&world),
            &dir.store(),
            &signals,
            &ctx(),
            Reason::Unwind,
        );
        assert!(report.failed.is_empty(), "k = {k}: {:?}", report.failed);
        assert_eq!(snapshot(&world), before, "k = {k}");
        assert!(untouched_music(&world), "k = {k}");
    }
}

#[test]
fn a_restorer_dying_midway_is_finished_by_the_next() {
    quiet_injected_faults();
    let total = writes_in_full_run("restorer", true);
    assert!(total >= 8, "{total}");
    for k in 0..total {
        let dir = TempDir::new("fault-restorer");
        let world = world();
        let before = snapshot(&world);
        let mut wm = Wm::start(&world, dir.store());
        scenario(&mut wm).unwrap();

        world.fault_after("restorer", Some(k));
        let store = dir.store();
        let signals = world.signals();
        let first = restorer(&world);
        let died = panic::catch_unwind(AssertUnwindSafe(|| {
            restore_all(&first, &store, &signals, &ctx(), Reason::Guard)
        }));
        assert!(died.is_err(), "k = {k}");

        // The journal mutex came back as the restorer unwound, so the next one isn't held up.
        let next = world.handle(Mode::Restoring, "next");
        let report = restore_all(&next, &store, &signals, &ctx(), Reason::Start);
        assert!(report.locked, "k = {k}");
        assert!(report.failed.is_empty(), "k = {k}: {:?}", report.failed);
        assert_eq!(snapshot(&world), before, "k = {k}");
        assert!(untouched_music(&world), "k = {k}");
    }
}
