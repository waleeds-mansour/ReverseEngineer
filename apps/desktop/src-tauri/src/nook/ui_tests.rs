// nook_ui's checks (ui.rs): which of Nook's pages may ask what.

use super::*;

#[test]
fn only_nooks_labels_pass() {
    for ok in [
        "nook_panel",
        "nook_popover",
        "nook_palette",
        "nook_bar_1",
        "nook_dock",
    ] {
        assert!(is_nook_label(ok), "{ok}");
    }
    for no in [
        "hearth",
        "main",
        "hearth_ask",
        "recording_overlay",
        "nook",
        "nook_bar",
        "xnook_panel",
    ] {
        assert!(!is_nook_label(no), "{no}");
    }
}

#[test]
fn the_bar_may_ask_only_what_it_draws() {
    for cmd in [UiCmd::Ready, UiCmd::Drawn, UiCmd::Popover { open: true }] {
        assert!(allowed(BAR_LABEL, &cmd), "{cmd:?}");
    }
    for cmd in [
        UiCmd::Refresh,
        UiCmd::SetObserve { on: true },
        UiCmd::SetBar { on: false },
        UiCmd::SetDock { on: false },
        UiCmd::SaveFixtures,
        UiCmd::ExportDiag,
    ] {
        assert!(!allowed(BAR_LABEL, &cmd), "{cmd:?}");
        assert!(!allowed(POPOVER_LABEL, &cmd), "{cmd:?}");
        assert!(!allowed(DOCK_LABEL, &cmd), "{cmd:?}");
        assert!(allowed(PANEL, &cmd), "{cmd:?}");
    }
    assert!(allowed(POPOVER_LABEL, &UiCmd::OpenToday));
    assert!(!allowed(PANEL, &UiCmd::Drawn));
    assert!(stays(BAR_LABEL) && stays(POPOVER_LABEL) && !stays(PANEL));
}

#[test]
fn the_dock_may_ask_what_it_draws_and_opens_and_nothing_else() {
    let page = super::super::view::DockPage::Approvals;
    let own = [
        UiCmd::DockShape {
            open: true,
            hold: false,
            outlines: vec![],
        },
        UiCmd::DockKeys { take: true },
        UiCmd::DockChoose {
            choice: super::super::view::DockChoice::Rest,
        },
        UiCmd::DockDrag,
        UiCmd::DockOpen { page },
        UiCmd::DockTalk,
        UiCmd::Inbox {
            act: super::super::inboxview::InboxAct::Open,
        },
    ];
    let mut all = vec![
        UiCmd::Ready,
        UiCmd::Drawn,
        UiCmd::OpenToday,
        UiCmd::Popover { open: true },
    ];
    all.extend(own.clone());
    for cmd in all {
        assert!(allowed(DOCK_LABEL, &cmd), "{cmd:?}");
    }
    for cmd in own {
        assert!(
            !allowed(BAR_LABEL, &cmd) && !allowed(PANEL, &cmd),
            "{cmd:?}"
        );
    }
    // Its side is the panel's to set; the dock's own menu sets it with a DockChoose.
    let side = UiCmd::SetDockEdge {
        edge: super::super::chrome::Edge::Left,
    };
    assert!(allowed(PANEL, &side) && !allowed(DOCK_LABEL, &side));
    assert!(stays(DOCK_LABEL));
}
