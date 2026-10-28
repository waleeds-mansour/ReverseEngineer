use super::tests::{owners_pc, rect, up};
use super::*;
use crate::nook::docksize::dock_rect;
use std::time::Duration;

#[test]
fn a_run_sits_on_the_right_edge_until_moved_and_a_new_window_keeps_its_place() {
    let mut run = up();
    assert_eq!(run.view().edge, Edge::Right);
    let right = dock_rect(&owners_pc(), Edge::Right, 1);
    assert_eq!(run.plan(), vec![DockStep::Place(right), DockStep::Show]);
    run.hover(true);
    let kept = run.move_to(Edge::Left);
    assert_eq!(kept.edge, Edge::Left);
    assert!(!run.open, "the pill closes as it moves");
    let left = dock_rect(&owners_pc(), Edge::Left, 1);
    assert_eq!(run.plan(), vec![DockStep::Place(left)]);
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
fn dragging_moves_the_tab_along_its_edge_kept_on_the_monitor() {
    let mut run = up();
    run.plan();
    run.hover(true);
    assert!(run.drag_start(720), "it shows, where it was put");
    assert!(!run.open, "the pill closes while it moves");
    run.hover(true);
    assert!(!run.open, "and stays closed");
    // 100 px down: the window's top from 659 to 759.
    assert!(run.drag_to(820));
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2521, 759, 2560, 881))]
    );
    assert!(!run.drag_to(820), "no move, nothing to do");
    // Far past the bottom: as low as it goes with room for the open pill below it.
    run.drag_to(5000);
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2521, 1251, 2560, 1373))]
    );
    run.drag_to(-5000);
    assert_eq!(run.plan(), vec![DockStep::Place(rect(2521, 67, 2560, 189))]);
    let kept = run.drag_end().expect("it was dragged");
    assert_eq!(kept.right, run.place.right);
    assert_eq!(kept.left, 0.5, "the other side's spot stays");
    assert_eq!(run.drag_end(), None);
    run.hover(true);
    assert!(run.open, "a pill again once it's let go");
    // Its pill opens where the tab is now, reaching the monitor's top and no further.
    let open = run.plan();
    assert_eq!(open, vec![DockStep::Place(rect(2176, 0, 2560, 256))]);
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
    run.hover(true);
    assert!(!run.open, "no pill while it rests");
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
fn dragging_from_the_open_pill_moves_the_tab_from_where_it_rests() {
    // As the page does it: the pointer opens the pill, its window widens, and then a press drags.
    let mut run = up();
    let rest = dock_rect(&owners_pc(), Edge::Right, 1);
    run.plan();
    run.hover(true);
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2176, 592, 2560, 848))]
    );
    assert!(run.drag_start(720));
    run.drag_to(720);
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rest)],
        "the tab doesn't jump"
    );
    run.drag_to(820);
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2521, 759, 2560, 881))]
    );
    // A window made again keeps its dots and badge, so a long tab isn't clipped meanwhile.
    run.dots = 3;
    run.waiting = true;
    let again = run.kept();
    assert_eq!((again.dots, again.waiting), (3, true));
}

#[test]
fn the_tab_and_its_pill_stay_above_the_taskbar() {
    let mut run = up();
    // A taskbar 48 px tall along the bottom.
    run.read(false, Some((owners_pc(), rect(0, 0, 2560, 1392))));
    run.plan();
    assert!(run.drag_start(720));
    run.drag_to(5000);
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2521, 1203, 2560, 1325))]
    );
    run.drag_end();
    run.hover(true);
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2176, 1136, 2560, 1392))]
    );
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
    run.hover(true);
    run.plan();
    assert_eq!(run.clip().map(|s| s.len()), Some(3), "open");
    run.label = LabelBox::read(100, 132, 250);
    assert_eq!(run.clip().map(|s| s.len()), Some(5), "the label showed");
    // The open window is (2176, 592) to (2560, 848): its far corners are outside the region.
    assert!(!run.pointer(Some((2540, 720))), "on the column");
    assert!(!run.pointer(Some((2400, 710))), "on the label");
    assert!(run.open);
    assert!(
        run.pointer(Some((2190, 840))),
        "in the window, but on nothing it draws"
    );
    assert!(!run.open);
    // Closed, the label goes with the pill, and the region is the tab's again.
    run.plan();
    assert_eq!(run.clip().map(|s| s.len()), Some(2));
    // At 150 % text, the same tab is drawn bigger, and so is its region.
    run.text = 150;
    run.plan();
    let tab = run.clip().expect("a new region")[0].bounds();
    assert_eq!((tab.right - tab.left, tab.bottom - tab.top), (42, 132));
}
