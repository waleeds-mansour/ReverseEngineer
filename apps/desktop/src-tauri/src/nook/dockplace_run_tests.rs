use super::tests::{owners_pc, rect, strip, up};
use super::*;
use crate::nook::chrome::Edge;
use std::time::Duration;

#[test]
fn a_run_sits_on_the_right_edge_until_moved_and_a_new_window_keeps_its_place() {
    let mut run = up();
    assert_eq!(run.view().edge, Edge::Right);
    let right = DockStep::Place(strip(Edge::Right));
    assert_eq!(run.plan(), vec![DockStep::Zoom(150), right, DockStep::Show]);
    run.shape(true, false, Vec::new());
    let kept = run.move_to(Edge::Left);
    assert_eq!(kept.edge, Edge::Left);
    assert!(!run.open, "the notch folds as it moves");
    assert_eq!(run.plan(), vec![DockStep::Place(strip(Edge::Left))]);
    assert_eq!(run.view().edge, Edge::Left);
    assert_eq!(
        run.move_to(Edge::Top).edge,
        Edge::Right,
        "the top is the bar's"
    );
    run.move_to(Edge::Left);
    // A window made again, after its page didn't draw or its switch went off and on, keeps it.
    let again = run.kept();
    assert_eq!((again.place, again.setting), (run.place, true));
    assert!(!again.made && again.placed.is_none());
}

#[test]
fn dragging_moves_the_tab_down_its_window_kept_on_the_monitor() {
    let mut run = up();
    run.plan();
    run.shape(true, false, Vec::new());
    assert_eq!((run.mid_px(), run.view().mid), (Some(720), 480));
    assert!(run.drag_start(720), "it shows, where it was put");
    assert!(!run.open, "the notch folds while it moves");
    run.shape(true, false, Vec::new());
    assert!(!run.open, "and stays folded");
    // 100 px down: the window stays where it is, and the tab's middle moves in it.
    assert!(run.drag_to(820));
    assert_eq!(run.plan(), vec![]);
    assert_eq!((run.mid_px(), run.view().mid), (Some(820), 547));
    // The region keeps the tab where the page last drew it too, until it draws the move.
    assert_eq!(run.trail, Some(480));
    assert_eq!(
        run.clip_key().map(|k| (k.mid, k.trail)),
        Some((547, Some(480)))
    );
    assert!(!run.drag_to(820), "no move, nothing to do");
    // Far past the bottom: as low as the whole tab stays 12 px above it, at 150 %.
    run.drag_to(5000);
    assert_eq!(run.mid_px(), Some(1440 - 80));
    run.drag_to(-5000);
    assert_eq!(run.mid_px(), Some(80));
    let kept = run.drag_end().expect("it was dragged");
    assert_eq!(
        run.clip_key().map(|k| k.trail),
        Some(None),
        "let go: the tab alone"
    );
    assert_eq!(kept.right, run.place.right);
    assert_eq!(kept.left, 0.5, "the other side's spot stays");
    assert_eq!(run.drag_end(), None);
    run.shape(true, false, Vec::new());
    assert!(run.open, "it opens again once it's let go");
    // Nothing to drag while it's hidden.
    run.read(true, None);
    assert!(!run.drag_start(0));
}

#[test]
fn hidden_for_an_hour_it_comes_back_on_its_own_or_with_its_switch() {
    let mut run = up();
    run.plan();
    let now = Instant::now();
    let hour = Duration::from_secs(3600);
    run.rest(now + hour);
    assert!(!run.visible());
    assert_eq!(run.plan(), vec![DockStep::Hide, DockStep::Sleep]);
    assert_eq!(run.view().why_not.as_deref(), Some(RESTING));
    run.shape(true, true, Vec::new());
    assert!(!run.open && !run.hold, "no notch while it rests");
    assert!(!run.wake(now + hour - Duration::from_secs(1)));
    assert!(run.wake(now + hour));
    assert!(!run.wake(now + hour), "once");
    assert_eq!(run.plan(), vec![DockStep::Wake, DockStep::Show]);
    // A window made again rests on; turning the switch either way ends it.
    run.rest(now + hour);
    assert!(run.kept().resting.is_some());
    run.switch(true);
    assert!(run.visible());
    run.rest(now + hour);
    run.switch(false);
    assert_eq!(run.view().why_not, None);
}

#[test]
fn a_new_window_keeps_its_dots_and_badge_so_a_long_tab_isnt_clipped_meanwhile() {
    let mut run = up();
    run.dots = 3;
    run.waiting = true;
    let again = run.kept();
    assert_eq!((again.dots, again.waiting), (3, true));
}

#[test]
fn the_window_fills_the_work_area_so_the_notch_stays_above_the_taskbar() {
    let mut run = up();
    // A taskbar 48 px tall along the bottom.
    run.read(false, Some((owners_pc(), rect(0, 0, 2560, 1392))));
    assert_eq!(run.plan()[1], DockStep::Place(rect(1780, 0, 2560, 1392)));
    assert!(run.drag_start(720));
    run.drag_to(5000);
    assert_eq!(run.mid_px(), Some(1392 - 80));
    run.drag_end();
    // A work area that doesn't fit the monitor is no work area.
    run.read(false, Some((owners_pc(), rect(0, -50, 2560, 1392))));
    assert_eq!(run.at().map(|a| a.rect), Some(owners_pc().rect));
}

#[test]
fn the_window_is_clipped_after_every_change_and_the_watch_counts_only_its_region() {
    let mut run = up();
    run.plan();
    assert_eq!(run.clip().map(|s| s.len()), Some(1), "the tab");
    assert_eq!(run.clip(), None, "nothing changed");
    run.waiting = true;
    assert_eq!(run.clip().map(|s| s.len()), Some(2), "the badge came");
    // Open, the page draws the badge itself and says where it draws.
    let column = vec![
        (468.0, 380.0),
        (520.0, 380.0),
        (520.0, 580.0),
        (468.0, 580.0),
    ];
    run.shape(true, false, vec![column.clone()]);
    assert_eq!(
        run.clip().map(|s| s.len()),
        Some(2),
        "the tab and the column"
    );
    run.shape(true, false, vec![column.clone(), column]);
    assert_eq!(
        run.clip().map(|s| s.len()),
        Some(3),
        "a morph's two outlines"
    );
    assert!(!run.pointer(Some((2540, 720))), "on the column");
    assert!(
        run.pointer(Some((2190, 840))),
        "in the window, on nothing it draws"
    );
    assert!(!run.open);
    // Folded and settled, the page sends nothing, and the region is the tab's and its badge's.
    run.shape(false, false, Vec::new());
    assert_eq!(run.clip().map(|s| s.len()), Some(2));
    // A drag moves the tab's piece with it.
    run.drag_start(720);
    run.drag_to(620);
    let moved = run.clip().expect("a new region")[0].bounds();
    assert_eq!((moved.top + moved.bottom) / 2, 620);
    run.drag_end();
    // At 150 % text, the same tab is drawn bigger, and so is its region.
    run.text = 150;
    run.plan();
    let tab = run.clip().expect("a new region")[0].bounds();
    assert_eq!((tab.right - tab.left, tab.bottom - tab.top), (63, 198));
}
