use super::*;
use crate::nook::view::{FocusedView, GateView, MonitorView, RectView, VerdictName};

const DISPLAY1: RectView = RectView {
    x: 0,
    y: 0,
    width: 2560,
    height: 1440,
};
const DISPLAY2: RectView = RectView {
    x: 2560,
    y: 0,
    width: 1920,
    height: 1080,
};

/// An app's window in front, on `monitor`.
fn app(hwnd: Hwnd, monitor: RectView) -> Option<FrontWindow> {
    Some(FrontWindow {
        hwnd,
        monitor: Some(monitor),
        elevated: Some(false),
        ..FrontWindow::default()
    })
}

/// The guard tripped for the window in front, on `monitor`.
fn fullscreen_on(monitor: RectView) -> NookState {
    NookState {
        focused: Some(FocusedView {
            app: "A game".into(),
            exe: None,
            verdict: VerdictName::Ignore,
            why: "Fullscreen".into(),
            game: true,
        }),
        front: app(0x300, monitor),
        ..observing()
    }
}

fn owners_pc() -> Place {
    Place {
        rect: Rect {
            left: 0,
            top: 0,
            right: 2560,
            bottom: 1440,
        },
        dpi: 96,
    }
}

fn observing() -> NookState {
    NookState {
        mode: ModeName::Observing,
        monitors: vec![
            MonitorView {
                name: "DISPLAY1".into(),
                rect: DISPLAY1,
                dpi: 96,
                primary: true,
                managed: true,
                ..MonitorView::default()
            },
            MonitorView {
                name: "DISPLAY2".into(),
                rect: DISPLAY2,
                dpi: 96,
                primary: false,
                managed: false,
                ..MonitorView::default()
            },
        ],
        front: app(0x100, DISPLAY1),
        ..NookState::default()
    }
}

fn drawn() -> BarRun {
    BarRun {
        setting: true,
        made: true,
        bar_drawn: true,
        popover_drawn: true,
        ..BarRun::default()
    }
}

#[test]
fn the_disabled_file_safe_start_and_a_fault_keep_it_off() {
    assert!(wanted(true, Status::Off, false).is_ok());
    assert!(wanted(true, Status::NotInThisVersion, false).is_ok());
    assert!(wanted(false, Status::Off, false).is_err());
    assert!(wanted(true, Status::Disabled, false).is_err());
    assert!(wanted(true, Status::SafeStart, false).is_err());
    assert!(wanted(true, Status::Off, true).is_err());
}

#[test]
fn the_bar_spans_display1_and_scales_with_it() {
    assert_eq!(
        bar_rect(&owners_pc()),
        Rect {
            left: 0,
            top: 0,
            right: 2560,
            bottom: 28
        }
    );
    let at_150 = Place {
        rect: Rect {
            left: -1920,
            top: -200,
            right: 0,
            bottom: 880,
        },
        dpi: 144,
    };
    let r = bar_rect(&at_150);
    assert_eq!(
        (r.left, r.top, r.width(), r.height()),
        (-1920, -200, 1920, 42)
    );
    let p = popover_rect(&owners_pc());
    assert_eq!(
        (p.top, p.right, p.width(), p.height()),
        (28, 2552, 304, 236)
    );
}

#[test]
fn the_bar_and_popover_are_sized_as_webview2_draws_them_at_windows_text_size() {
    let mut run = drawn();
    run.take(&observing());
    run.text = 150;
    let Step::Place { bar, popover } = run.plan()[0] else {
        panic!("placed first");
    };
    // 28 CSS px of bar at 150 % text on a 100 % monitor: 42 physical px, as at 150 % DPI.
    assert_eq!(
        (bar.left, bar.top, bar.width(), bar.height()),
        (0, 0, 2560, 42)
    );
    // The popover's 304 by 236 grows the same, under the taller bar, 12 px in from the right.
    let p = (
        popover.top,
        popover.right,
        popover.width(),
        popover.height(),
    );
    assert_eq!(p, (42, 2548, 456, 354));
    // A new text size moves both; at 100 % they are the DPI's alone.
    run.text = 100;
    let (bar, popover) = (bar_rect(&owners_pc()), popover_rect(&owners_pc()));
    assert_eq!(run.plan(), vec![Step::Place { bar, popover }]);
}

#[test]
fn it_shows_only_once_drawn_and_observing_on_a_managed_primary() {
    let mut run = BarRun {
        made: true,
        ..BarRun::default()
    };
    run.take(&observing());
    assert_eq!(run.monitor, Some(owners_pc()), "DISPLAY1, never DISPLAY2");
    let steps = run.plan();
    assert_eq!(
        steps.len(),
        1,
        "placed, not shown before it draws: {steps:?}"
    );
    assert!(matches!(steps[0], Step::Place { .. }));
    run.bar_drawn = true;
    assert_eq!(run.plan(), vec![Step::Show(Which::Bar), Step::NcActivate]);
    assert!(run.plan().is_empty(), "nothing to do twice");
    let mut off = observing();
    off.mode = ModeName::Off;
    run.take(&off);
    assert_eq!(
        run.plan(),
        vec![Step::Hide(Which::Bar), Step::Sleep(Which::Bar)]
    );
    run.take(&observing());
    assert_eq!(
        run.plan(),
        vec![Step::Wake(Which::Bar), Step::Show(Which::Bar)],
        "WM_NCACTIVATE only the first time"
    );
}

#[test]
fn fullscreen_on_the_bars_monitor_hides_it_and_closes_the_popover() {
    let mut run = drawn();
    run.take(&observing());
    run.popover_wanted = true;
    let first = run.plan();
    assert!(first.contains(&Step::Show(Which::Popover)), "{first:?}");
    run.take(&fullscreen_on(DISPLAY1));
    assert!(!run.popover_wanted);
    assert_eq!(
        run.plan(),
        vec![
            Step::Hide(Which::Popover),
            Step::Sleep(Which::Popover),
            Step::Hide(Which::Bar),
            Step::Sleep(Which::Bar),
        ]
    );
    // The guard's gate alone does it too, for a window Nook can't place on a monitor.
    let mut run = drawn();
    run.take(&observing());
    run.plan();
    let mut gated = observing();
    gated.front = None;
    gated.gates.push(GateView {
        name: "game_guard".into(),
        text: "A game is running".into(),
    });
    run.take(&gated);
    assert!(run.plan().contains(&Step::Hide(Which::Bar)));
}

#[test]
fn fullscreen_on_the_other_monitor_leaves_the_bar_up_and_still() {
    let mut run = drawn();
    run.take(&observing());
    run.popover_wanted = true;
    run.plan();
    run.take(&fullscreen_on(DISPLAY2));
    assert!(run.bar_visible(), "DISPLAY1's bar stays");
    assert!(run.view().quiet, "and Pip holds still");
    assert!(!run.popover_wanted);
    assert_eq!(
        run.plan(),
        vec![Step::Hide(Which::Popover), Step::Sleep(Which::Popover)],
        "the popover closes, the bar isn't touched"
    );
    // A click on Pip can't open it while the game is in front.
    assert!(!run.popover_allowed());
    // The game goes: the bar moves again, and the popover may open.
    run.take(&observing());
    assert!(!run.view().quiet);
    assert!(run.popover_allowed());
    assert!(run.plan().is_empty());
}

#[test]
fn the_popover_closes_when_another_app_comes_forward() {
    let mut run = drawn();
    run.take(&observing());
    run.popover_wanted = true;
    run.plan();
    // The same window in front again, as a new state for anything else: it stays open.
    run.take(&observing());
    assert!(run.popover_wanted);
    let mut other = observing();
    other.front = app(0x200, DISPLAY1);
    run.take(&other);
    assert!(!run.popover_wanted);
    assert_eq!(
        run.plan(),
        vec![Step::Hide(Which::Popover), Step::Sleep(Which::Popover)]
    );
    // The bar itself coming to the front leaves what was before it alone.
    run.ours = vec![0xB0, 0xB1];
    let mut bar = other.clone();
    bar.front = app(0xB0, DISPLAY1);
    run.popover_wanted = true;
    run.take(&bar);
    assert!(run.popover_wanted);
    assert_eq!(run.before.map(|b| b.hwnd), Some(0x200));
    // Hearth's own window counts as before: the foreground never goes back past it.
    let mut hearth = other.clone();
    hearth.front = app(0x400, DISPLAY1);
    run.take(&hearth);
    assert_eq!(run.before.map(|b| b.hwnd), Some(0x400));
}

#[test]
fn a_new_monitor_moves_both_windows() {
    let mut run = drawn();
    run.take(&observing());
    run.plan();
    let mut moved = observing();
    moved.monitors[0].dpi = 120;
    run.take(&moved);
    let steps = run.plan();
    assert_eq!(steps.len(), 1);
    let Step::Place { bar, popover } = steps[0] else {
        panic!("{steps:?}");
    };
    assert_eq!(bar.height(), 35);
    assert_eq!(popover.top, 35);
    // A primary that stayed away long enough for Nook to stop arranging it gets its bar back.
    let mut returned = observing();
    returned.monitors[0].managed = false;
    run.take(&returned);
    assert!(
        run.bar_visible(),
        "the bar follows the primary that is there"
    );
    // No primary there at all: the bar hides.
    let mut none = observing();
    none.monitors.remove(0);
    run.take(&none);
    assert!(run.plan().contains(&Step::Hide(Which::Bar)));
}

#[test]
fn a_window_covering_display1_hides_the_bar_but_the_desktop_doesnt() {
    let mut run = drawn();
    run.take(&observing());
    run.popover_wanted = true;
    run.plan();
    let with_rect = |rect| {
        let mut s = observing();
        s.front = s.front.map(|f| FrontWindow { rect, ..f });
        s
    };
    // A browser gone fullscreen before the guard has judged it, or stretched past the edges.
    let past = RectView {
        x: -8,
        y: -8,
        width: 2576,
        height: 1456,
    };
    run.take(&with_rect(Some(past)));
    assert!(run.covered && !run.bar_visible() && !run.popover_wanted);
    assert!(!run.view().quiet, "not a game: Pip needn't hold still");
    assert_eq!(
        run.plan(),
        vec![
            Step::Hide(Which::Popover),
            Step::Sleep(Which::Popover),
            Step::Hide(Which::Bar),
            Step::Sleep(Which::Bar),
        ]
    );
    // Maximized, above the taskbar: the bar comes back.
    let maximized = RectView {
        height: 1400,
        ..past
    };
    run.take(&with_rect(Some(maximized)));
    assert!(run.bar_visible());
    // The desktop covers every monitor, and hides nothing.
    run.take(&with_rect(None));
    assert!(run.bar_visible());
    // A window covering DISPLAY2 only.
    run.take(&with_rect(Some(DISPLAY2)));
    assert!(run.bar_visible());
    // The bar's own window in front is never taken for one that covers.
    run.ours = vec![0x100];
    run.take(&with_rect(Some(past)));
    assert!(run.bar_visible());
}

#[test]
fn a_bar_that_never_draws_is_made_again_once_then_left_hidden() {
    let mut run = drawn();
    assert_eq!(run.undrawn(), None, "it drew");
    run.bar_drawn = false;
    run.ours = vec![0xB0, 0xB1];
    assert_eq!(run.undrawn(), Some(true));
    assert!(!run.made && run.ours.is_empty() && run.setting && run.remade);
    assert_eq!(run.undrawn(), None, "nothing made yet");
    run.made = true;
    assert_eq!(run.undrawn(), Some(false), "only once");
    assert!(run.made, "left as it is");
    assert!(run.view().why_not.unwrap().contains("didn't draw"));
}

#[test]
fn a_sleeping_page_is_sent_nothing() {
    let mut run = drawn();
    assert!(run.receives(BAR_LABEL));
    run.take(&NookState::default());
    run.plan();
    assert!(!run.receives(BAR_LABEL));
    assert!(!run.receives(POPOVER_LABEL));
    assert!(run.receives("nook_panel"));
}

#[test]
fn the_switch_says_why_there_is_no_bar() {
    let mut run = BarRun {
        setting: true,
        why_not: Some("Safe start"),
        ..BarRun::default()
    };
    assert_eq!(run.view().why_not.as_deref(), Some("Safe start"));
    run.setting = false;
    assert_eq!(run.view().why_not, None, "off is its own reason");
}
