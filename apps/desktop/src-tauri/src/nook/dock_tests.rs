use super::*;
use crate::nook::bar::{bar_rect, popover_rect, strip_rect};
use crate::nook::chrome::Edge;
use crate::nook::dockread::busy;
use crate::nook::docksize::*;
use crate::nook::view::{FocusedView, FrontWindow, MonitorView, RectView, VerdictName};

const DISPLAY1: RectView = RectView {
    x: 0,
    y: 0,
    width: 2560,
    height: 1440,
};

pub(super) fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
    Rect {
        left,
        top,
        right,
        bottom,
    }
}

pub(super) fn owners_pc() -> Place {
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

/// A monitor read by the dock itself, with its work area the whole monitor.
pub(super) fn whole(at: Place) -> (Place, Rect) {
    (at, at.rect)
}

/// A dock that is on, made, drawn and has read the owner's monitor, with nothing in front.
pub(super) fn up() -> DockRun {
    let mut run = DockRun::new(true);
    run.made = true;
    run.drawn = true;
    run.dots = 1;
    run.read(false, Some(whole(owners_pc())));
    run
}

/// The window on the owner's monitor at the dock's own 150 %: 520 CSS px deep, the whole height.
pub(super) fn strip(edge: Edge) -> Rect {
    window_rect(&dock_at(&owners_pc(), 100, 150), edge)
}

#[test]
fn the_tab_grows_with_its_dots_and_the_window_is_made_at_its_biggest() {
    // The tab: 25 out from the edge, a 60 px body for two dots between two 22 px flares, and 22
    // more for each dot after.
    assert_eq!((TAB_DEEP, tab_long(2)), (25, 104));
    assert_eq!((tab_long(1), tab_long(3)), (82, 126));
    assert_eq!(tab_long(0), tab_long(1));
    // The window: the open column, the widest panel with its padding, and room past it, the work
    // area's whole height, flush with the edge.
    assert_eq!(WINDOW_DEEP, 52 + 420 + 32 + 16);
    let at = owners_pc();
    assert_eq!(window_rect(&at, Edge::Left), rect(0, 0, 520, 1440));
    assert_eq!(window_rect(&at, Edge::Right), rect(2040, 0, 2560, 1440));
    // At the dock's 150 % everything scales, and it stays flush.
    assert_eq!(strip(Edge::Right), rect(1780, 0, 2560, 1440));
    // Its sizes, as picked from its menu: an odd stored one reads as the nearest.
    assert_eq!(SCALE, 150);
    assert_eq!(
        (scale(125), scale(130), scale(0), scale(900)),
        (125, 125, 100, 175)
    );
}

#[test]
fn the_strip_follows_a_monitor_left_of_the_primary_and_never_leaves_it() {
    let left_of = Place {
        rect: rect(-1920, 200, 0, 1280),
        dpi: 96,
    };
    assert_eq!(
        window_rect(&left_of, Edge::Left),
        rect(-1920, 200, -1400, 1280)
    );
    assert_eq!(window_rect(&left_of, Edge::Right), rect(-520, 200, 0, 1280));
}

#[test]
fn the_bar_is_the_top_edges_whole_strip_and_its_popover_sits_under_it() {
    let at = owners_pc();
    assert_eq!(strip_rect(&at, Edge::Top, 28, None, 0), bar_rect(&at));
    assert_eq!(bar_rect(&at), rect(0, 0, 2560, 28));
    assert_eq!(popover_rect(&at), rect(2248, 28, 2552, 264));
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
    run.read(false, Some(whole(owners_pc())));
    let placed = DockStep::Place(strip(Edge::Right));
    assert_eq!(
        run.plan(),
        vec![DockStep::Zoom(150), placed],
        "zoomed and placed, but hidden until its page draws"
    );
    run.drawn = true;
    assert_eq!(run.plan(), vec![DockStep::Show]);
    assert_eq!(run.plan(), vec![], "nothing more to do");
    run.read(true, Some(whole(owners_pc())));
    assert_eq!(run.plan(), vec![DockStep::Hide, DockStep::Sleep]);
    run.read(false, Some(whole(owners_pc())));
    assert_eq!(run.plan(), vec![DockStep::Wake, DockStep::Show]);
    assert!(run.view().shown);
}

#[test]
fn while_nook_observes_its_game_guard_hides_it_too() {
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
    // Busy by Windows' reckoning while nook-wm sees nothing in front: hidden all the same, since
    // nook-wm misses a window going fullscreen in place unless the bar follows the front window.
    run.take(&observing());
    run.read(true, None);
    assert!(!run.visible(), "Windows' reading always counts");
    run.read(false, None);
    assert!(run.visible());
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
    // Observing stops: Windows' reading still counts, and the monitor it had stays.
    run.take(&NookState::default());
    run.read(true, None);
    assert!(!run.visible(), "Windows says busy");
    run.read(false, None);
    assert!(run.visible());
    assert_eq!(run.monitor, Some(owners_pc()));
}

#[test]
fn the_page_opens_the_notch_only_while_it_shows_and_the_window_never_moves() {
    let mut run = up();
    run.plan();
    assert!(
        run.shape(true, false, Vec::new()),
        "opened: the pointer is watched"
    );
    assert!(run.view().open);
    assert_eq!(run.plan(), vec![], "only the region changes");
    assert!(!run.shape(true, false, Vec::new()), "open already");
    run.shape(false, true, Vec::new());
    assert!(
        !run.open && run.hold,
        "a notice holds it with the column folded"
    );
    run.shape(false, false, Vec::new());
    assert_eq!(run.plan(), vec![]);
    // Something fullscreen comes in front while it is open: it folds, and nothing holds it.
    run.shape(true, true, Vec::new());
    run.read(true, None);
    assert!(!run.open && !run.hold);
    run.shape(true, true, Vec::new());
    assert!(!run.open && !run.hold, "no notch on a hidden dock");
}

#[test]
fn a_new_dot_grows_the_tab_and_a_dock_with_no_monitor_waits() {
    let mut run = up();
    run.plan();
    run.dots = 2;
    assert_eq!(
        run.plan(),
        vec![],
        "the window stays; the region grows (dockclip.rs)"
    );
    let mut nowhere = DockRun::new(true);
    nowhere.made = true;
    nowhere.drawn = true;
    assert_eq!(
        nowhere.plan(),
        vec![DockStep::Sleep],
        "no monitor read yet: nothing to place or show, and its page sleeps"
    );
    nowhere.read(false, Some(whole(owners_pc())));
    assert_eq!(
        nowhere.plan(),
        vec![
            DockStep::Zoom(150),
            DockStep::Place(strip(Edge::Right)),
            DockStep::Wake,
            DockStep::Show
        ]
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

#[test]
fn the_window_is_sized_as_webview2_draws_its_page_at_windows_text_size_and_the_docks() {
    assert_eq!(text_size(None), 100, "Windows keeps no factor at 100 %");
    assert_eq!(text_size(Some(150)), 150);
    assert_eq!(text_size(Some(40)), 100);
    assert_eq!(text_size(Some(500)), 225);
    let at = owners_pc();
    assert_eq!(dock_at(&at, 0, 100), at, "not read yet: 100 %");
    // 150 % text on a 100 % monitor: each CSS px is 1.5 physical px, as at 150 % DPI, and so is
    // the dock's own 150 %.
    assert_eq!(dock_at(&at, 150, 100).dpi, 144);
    assert_eq!(dock_at(&at, 100, 150).dpi, 144);
    // The DPI scale, the text size and the dock's size multiply: 125 % and 200 % draw at 250 %.
    let hidpi = Place { dpi: 120, ..at };
    assert_eq!(dock_at(&hidpi, 200, 100).dpi, 240);
    assert_eq!(dock_at(&hidpi, 115, 100).dpi, 138);
    assert_eq!(dock_at(&at, 175, 175).dpi, 294);

    // A run places its window by the text size it read, and a new one moves it.
    let mut run = up();
    run.text = 175;
    let steps = run.plan();
    let at175 = dock_at(&owners_pc(), 175, 150);
    assert_eq!(steps[1], DockStep::Place(window_rect(&at175, Edge::Right)));
    assert_eq!(
        window_rect(&at175, Edge::Right).width(),
        1365,
        "520 CSS px at 175 % and the dock's 150 %"
    );
    let before = run.seen();
    run.text = 100;
    assert_ne!(before, run.seen(), "a new text size is a move");
    assert_eq!(run.plan(), vec![DockStep::Place(strip(Edge::Right))]);
    // A new size for the dock zooms its page and makes the window match.
    run.scale = 100;
    assert_ne!(before, run.seen());
    assert_eq!(
        run.plan(),
        vec![
            DockStep::Zoom(100),
            DockStep::Place(window_rect(&owners_pc(), Edge::Right))
        ]
    );
    assert_eq!(run.view().scale, 100);
    // The page hears where the tab's middle is, in its own CSS px.
    assert_eq!(run.view().mid, 720);
    run.scale = 150;
    assert_eq!(run.view().mid, 480);
}

#[test]
fn its_sounds_and_size_start_as_they_should_and_a_new_window_keeps_the_owners_choice() {
    let mut run = DockRun::new(true);
    assert!(run.sounds && run.view().sounds);
    assert_eq!((run.scale, run.view().scale), (150, 150));
    run.sounds = false;
    run.scale = 125;
    assert!(!run.view().sounds);
    let again = run.kept();
    assert!(!again.sounds, "made again, it stays quiet");
    assert_eq!(
        (again.scale, again.zoomed),
        (125, None),
        "and is zoomed again"
    );
}

#[test]
fn an_open_notch_folds_once_the_pointer_has_left_what_it_draws() {
    let mut run = up();
    run.plan();
    // The open column the page draws, as an outline in CSS px: 52 deep on the right edge.
    let column = vec![
        (468.0, 380.0),
        (520.0, 380.0),
        (520.0, 580.0),
        (468.0, 580.0),
    ];
    run.shape(true, false, vec![column]);
    // On the column, in the window's physical px at 150 %, it stays open.
    assert!(!run.pointer(Some((2559, 600))));
    assert!(!run.pointer(Some((2490, 860))));
    assert!(run.open);
    // In the window but on nothing it draws, it folds, once.
    assert!(run.pointer(Some((1800, 720))));
    assert!(!run.open && !run.view().open);
    assert!(!run.pointer(Some((1800, 720))), "folded already");
    // Held open by a panel, the pointer may go anywhere.
    run.shape(true, true, Vec::new());
    assert!(!run.pointer(Some((0, 0))) && run.open);
    // Where Windows can't tell where the pointer is (a secure desktop, say), it folds too.
    run.shape(true, false, Vec::new());
    assert!(run.pointer(None));
    // On the tab itself it stays: Nook keeps the tab's own piece whatever the page says.
    run.shape(true, false, Vec::new());
    assert!(!run.pointer(Some((2555, 720))));
}
