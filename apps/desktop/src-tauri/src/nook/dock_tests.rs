use super::*;
use crate::nook::bar::{bar_rect, popover_rect};
use crate::nook::view::{FocusedView, FrontWindow, MonitorView, RectView, VerdictName};

const DISPLAY1: RectView = RectView {
    x: 0,
    y: 0,
    width: 2560,
    height: 1440,
};

fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

fn owners_pc() -> Place {
    Place {
        rect: rect(0, 0, 2560, 1440),
        dpi: 96,
    }
}

fn observing() -> NookState {
    NookState {
        mode: ModeName::Observing,
        monitors: vec![MonitorView {
            name: "DISPLAY1".into(),
            rect: DISPLAY1,
            dpi: 96,
            primary: true,
            ..MonitorView::default()
        }],
        ..NookState::default()
    }
}

/// A dock that is on, made, drawn and has read the owner's monitor, with nothing in front.
fn up() -> DockRun {
    let mut run = DockRun::new(true);
    run.made = true;
    run.drawn = true;
    run.dots = 1;
    run.read(false, Some(owners_pc()));
    run
}

#[test]
fn the_strip_floats_on_the_left_edge_centred_and_grows_with_its_dots() {
    let at = owners_pc();
    // One dot: 6 + 24 + 6 tall, 28 deep, 6 in from the edge, centred top to bottom.
    assert_eq!(dock_rect(&at, Edge::Left, 1), rect(6, 702, 34, 738));
    assert_eq!(dock_rect(&at, Edge::Left, 0), dock_rect(&at, Edge::Left, 1));
    assert_eq!(dock_rect(&at, Edge::Left, 4), rect(6, 666, 34, 774));
    assert_eq!(dock_rect(&at, Edge::Right, 1), rect(2526, 702, 2554, 738));
    // At 150 % everything scales, and it stays centred.
    let hidpi = Place { dpi: 144, ..at };
    assert_eq!(dock_rect(&hidpi, Edge::Left, 1), rect(9, 693, 51, 747));
}

#[test]
fn the_strip_follows_a_monitor_left_of_the_primary_and_never_leaves_it() {
    let left_of = Place {
        rect: rect(-1920, 200, 0, 1280),
        dpi: 96,
    };
    assert_eq!(
        dock_rect(&left_of, Edge::Left, 1),
        rect(-1914, 722, -1886, 758)
    );
    // A strip longer than the edge is the whole edge.
    let r = strip_rect(&left_of, Edge::Left, DOCK_DEEP, Some(5000), DOCK_INSET);
    assert_eq!((r.top, r.bottom), (200, 1280));
}

#[test]
fn the_bar_is_the_top_edges_whole_strip_and_its_popover_sits_under_it() {
    let at = owners_pc();
    assert_eq!(strip_rect(&at, Edge::Top, 28, None, 0), bar_rect(&at));
    assert_eq!(bar_rect(&at), rect(0, 0, 2560, 28));
    assert_eq!(popover_rect(&at), rect(2248, 28, 2552, 264));
}

#[test]
fn the_open_card_has_room_beside_the_strip_which_stays_put() {
    let at = owners_pc();
    let strip = dock_rect(&at, Edge::Left, 1);
    let open = window_rect(&at, Edge::Left, 1, true);
    assert_eq!(open, rect(6, 702, 282, 774));
    assert_eq!((open.left, open.top), (strip.left, strip.top));
    assert_eq!(window_rect(&at, Edge::Left, 1, false), strip);
    // On the right edge the card opens leftward.
    assert_eq!(
        window_rect(&at, Edge::Right, 1, true),
        rect(2278, 702, 2554, 774)
    );
    // With more dots than the card is tall, the window is as tall as the strip.
    let four = window_rect(&at, Edge::Left, 4, true);
    assert_eq!(four, rect(6, 666, 282, 774));
}

#[test]
fn the_dock_starts_on_and_yields_to_the_disabled_file_and_safe_start() {
    assert!(wanted(true, Status::Off).is_ok());
    assert!(wanted(true, Status::NotInThisVersion).is_ok());
    assert!(wanted(false, Status::Off).is_err());
    assert!(wanted(true, Status::Disabled).is_err());
    assert!(wanted(true, Status::SafeStart).is_err());
}

#[test]
fn windows_busy_states_hide_it() {
    for quns in [1, 2, 3, 4, 7] {
        assert!(busy(quns), "{quns}");
    }
    for quns in [0, 5, 6, 8] {
        assert!(!busy(quns), "{quns}");
    }
}

#[test]
fn it_shows_once_drawn_and_hides_and_sleeps_over_something_fullscreen() {
    let mut run = DockRun::new(true);
    run.made = true;
    run.read(false, Some(owners_pc()));
    let placed = DockStep::Place(dock_rect(&owners_pc(), Edge::Left, 0));
    assert_eq!(
        run.plan(),
        vec![placed],
        "placed, but hidden until its page draws"
    );
    run.drawn = true;
    assert_eq!(run.plan(), vec![DockStep::Show]);
    assert_eq!(run.plan(), vec![], "nothing more to do");
    run.read(true, Some(owners_pc()));
    assert_eq!(run.plan(), vec![DockStep::Hide, DockStep::Sleep]);
    run.read(false, Some(owners_pc()));
    assert_eq!(run.plan(), vec![DockStep::Wake, DockStep::Show]);
    assert!(run.view().shown);
}

#[test]
fn while_nook_observes_its_game_guard_decides_not_windows() {
    let mut run = up();
    run.plan();
    // A game on the dock's monitor: hidden, though Windows doesn't say busy.
    let game = NookState {
        focused: Some(FocusedView {
            app: "A game".into(),
            exe: None,
            verdict: VerdictName::Ignore,
            why: "Fullscreen".into(),
            game: true,
        }),
        front: Some(FrontWindow {
            hwnd: 0x300,
            monitor: Some(DISPLAY1),
            ..FrontWindow::default()
        }),
        ..observing()
    };
    run.take(&game);
    assert!(!run.visible());
    // Busy by Windows' reckoning, but nook-wm sees nothing in front of this monitor.
    run.take(&observing());
    run.read(true, None);
    assert!(run.visible(), "nook-wm knows better, monitor by monitor");
    // A window covering the whole monitor hides it too.
    let covered = NookState {
        front: Some(FrontWindow {
            hwnd: 0x400,
            rect: Some(DISPLAY1),
            ..FrontWindow::default()
        }),
        ..observing()
    };
    run.take(&covered);
    assert!(!run.visible());
    // Its own window in front covers nothing.
    run.ours = vec![0x400];
    run.take(&covered);
    assert!(run.visible());
    // Observing stops: Windows' reading counts again, and the monitor it had stays.
    run.take(&NookState::default());
    assert!(!run.visible(), "Windows still says busy");
    run.read(false, None);
    assert!(run.visible());
    assert_eq!(run.monitor, Some(owners_pc()));
}

#[test]
fn hovering_opens_the_card_only_while_it_shows() {
    let mut run = up();
    run.plan();
    run.hover(true);
    assert!(run.view().open);
    let open = window_rect(&owners_pc(), Edge::Left, 1, true);
    assert_eq!(run.plan(), vec![DockStep::Place(open)]);
    run.hover(false);
    let closed = window_rect(&owners_pc(), Edge::Left, 1, false);
    assert_eq!(run.plan(), vec![DockStep::Place(closed)]);
    // Something fullscreen comes in front while the pointer is over it: the card closes too.
    run.hover(true);
    run.read(true, None);
    assert!(!run.open);
    run.hover(true);
    assert!(!run.open, "no card on a hidden dock");
}

#[test]
fn a_new_dot_moves_the_strip_and_a_dock_with_no_monitor_waits() {
    let mut run = up();
    run.plan();
    run.dots = 2;
    let two = dock_rect(&owners_pc(), Edge::Left, 2);
    assert_eq!(run.plan(), vec![DockStep::Place(two)]);
    let mut nowhere = DockRun::new(true);
    nowhere.made = true;
    nowhere.drawn = true;
    assert_eq!(
        nowhere.plan(),
        vec![DockStep::Sleep],
        "no monitor read yet: nothing to place or show, and its page sleeps"
    );
    nowhere.read(false, Some(owners_pc()));
    let one = dock_rect(&owners_pc(), Edge::Left, 0);
    assert_eq!(
        nowhere.plan(),
        vec![DockStep::Place(one), DockStep::Wake, DockStep::Show]
    );
}

#[test]
fn a_page_that_never_draws_is_made_again_once_then_left_hidden_saying_why() {
    let mut run = DockRun::new(true);
    assert_eq!(run.undrawn(), None, "not made");
    run.made = true;
    assert_eq!(run.undrawn(), Some(true));
    assert!(!run.made && run.remade && run.setting);
    run.made = true;
    assert_eq!(run.undrawn(), Some(false));
    assert!(run.view().why_not.is_some());
    run.drawn = true;
    assert_eq!(run.undrawn(), None, "it drew after all");
}

#[test]
fn the_view_says_why_only_while_the_switch_is_on_and_an_asleep_page_hears_nothing() {
    let mut run = up();
    run.why_not = Some("The dock's page didn't draw; nook.log says more");
    assert!(run.view().why_not.is_some());
    run.setting = false;
    assert_eq!(run.view().why_not, None);
    assert!(!run.view().on);
    assert!(run.receives());
    run.asleep = true;
    assert!(!run.receives());
}
