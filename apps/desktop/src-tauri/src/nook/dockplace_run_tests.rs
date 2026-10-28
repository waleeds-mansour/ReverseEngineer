use super::tests::{owners_pc, rect, up};
use super::*;
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
    assert!(!run.open, "the card closes as it moves");
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
fn dragging_moves_the_strip_along_its_edge_kept_on_the_monitor() {
    let mut run = up();
    run.plan();
    run.hover(true);
    assert!(run.drag_start(720), "it shows, where it was put");
    assert!(!run.open, "the card closes while it moves");
    run.hover(true);
    assert!(!run.open, "and stays closed");
    // 100 px down: the strip's top from 702 to 802.
    assert!(run.drag_to(820));
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2526, 802, 2554, 838))]
    );
    assert!(!run.drag_to(820), "no move, nothing to do");
    // Far past the bottom: as low as it goes with room for the card.
    run.drag_to(5000);
    assert_eq!(
        run.plan(),
        vec![DockStep::Place(rect(2526, 1342, 2554, 1378))]
    );
    run.drag_to(-5000);
    assert_eq!(run.plan(), vec![DockStep::Place(rect(2526, 6, 2554, 42))]);
    let kept = run.drag_end().expect("it was dragged");
    assert_eq!(kept.right, run.place.right);
    assert_eq!(kept.left, 0.5, "the other side's spot stays");
    assert_eq!(run.drag_end(), None);
    run.hover(true);
    assert!(run.open, "a card again once it's let go");
    // Its card opens where the strip is now, still on the monitor.
    let open = run.plan();
    assert_eq!(open, vec![DockStep::Place(rect(2278, 6, 2554, 98))]);
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
    assert!(!run.open, "no card while it rests");
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
