// The agent dock's sizes, in its page's CSS px (dock.css keeps the same numbers as custom
// properties), and the window they make on a monitor. At rest the dock is the edge tab: a solid
// black tab TAB_DEEP px out from the side of the screen, flush with it, whose straight body grows
// with its dots (a 13 px slot each, 9 px between, 60 px for two) between two 22 px S-shaped flares
// that meet the edge tangentially, so the tab grows out of the edge rather than sitting on it. Its
// window is the tab plus TAB_ROOM beside and around it, where its count badge falls; the window is
// clipped to what it draws (dockclip.rs), so that room takes no clicks.
// Hovered, the window widens toward the middle of the screen for the open pill, a column of 34 px
// capsules PILL_INSET px in from the edge (the Inbox button, the agents' dots, the tools, and "…"),
// and the status label that shows beside a hovered dot. The open window is centred on the resting
// one, so the tab stays exactly where it was, and dockplace.rs keeps the tab low and high enough
// that the open window always fits on the monitor.

use super::bar::{strip_rect, Place};
use super::chrome::Edge;
use super::probe::Rect;

/// How far the edge tab sticks out from its edge.
pub const TAB_DEEP: i32 = 25;
/// The S-shaped flare at the tab's top and at its bottom, where it meets the edge.
pub const TAB_FLARE: i32 = 22;
/// A dot's slot in the tab, and the gap between two slots.
pub const TAB_SLOT: i32 = 13;
pub const TAB_GAP: i32 = 9;
/// The body's room above its first slot and below its last, together: 60 px for two dots.
pub const TAB_PAD: i32 = 25;
/// Room beside the tab, toward the middle, and above and below it, for its count badge.
pub const TAB_ROOM: (i32, i32) = (14, 20);
/// How deep the dock's window is at rest: the tab and the room beside it.
pub const DOCK_DEEP: i32 = TAB_DEEP + TAB_ROOM.0;
/// The tab is flush with the screen's edge.
pub const DOCK_INSET: i32 = 0;

/// The open pill: a column PILL_WIDE across, PILL_INSET in from the edge, PILL_GAP between its
/// capsules.
pub const PILL_INSET: i32 = 14;
pub const PILL_WIDE: i32 = 34;
pub const PILL_GAP: i32 = 8;
/// The round Inbox and "…" buttons.
pub const PILL_BUTTON: i32 = 34;
/// The agents capsule: AGENTS_PAD above its first dot and below its last, AGENT_SLOT per dot,
/// AGENT_GAP between.
pub const AGENTS_PAD: i32 = 12;
pub const AGENT_SLOT: i32 = 11;
pub const AGENT_GAP: i32 = 9;
/// The tools capsule: Pip's mark (18) and the mic (17), 12 between, 11 above and below. The
/// "point at it" camera (17, and 12 more between) joins it with lane O7, and this grows by 29.
pub const TOOLS_LONG: i32 = 11 + 18 + 12 + 17 + 11;
/// The status label beside the column, toward the middle: LABEL_GAP from it, at most LABEL_WIDE.
pub const LABEL_GAP: i32 = 12;
pub const LABEL_WIDE: i32 = 300;
/// Room past the label, and above and below the column, for the Inbox badge and the springs. Their
/// shadows are close (0 1 2), since the window's region cuts off anything wider.
pub const PILL_ROOM: (i32, i32) = (24, 30);
/// How deep the dock's window is while the pill is open.
pub const OPEN_DEEP: i32 = PILL_INSET + PILL_WIDE + LABEL_GAP + LABEL_WIDE + PILL_ROOM.0;

/// `dots` slots of `slot` px with `gap` between them; one even with none.
fn slots(dots: usize, slot: i32, gap: i32) -> i32 {
    let n = dots.max(1) as i32;
    n * slot + (n - 1) * gap
}

/// How long the tab is along its edge: its body and both flares.
pub fn tab_long(dots: usize) -> i32 {
    2 * TAB_FLARE + TAB_PAD + slots(dots, TAB_SLOT, TAB_GAP)
}

/// How long the dock's window is at rest: the tab and the room above and below it.
pub fn rest_long(dots: usize) -> i32 {
    tab_long(dots) + 2 * TAB_ROOM.1
}

/// How long the open pill is: the Inbox button, the agents, the tools and "…".
pub fn pill_long(dots: usize) -> i32 {
    2 * PILL_BUTTON
        + 3 * PILL_GAP
        + 2 * AGENTS_PAD
        + slots(dots, AGENT_SLOT, AGENT_GAP)
        + TOOLS_LONG
}

/// How long the dock's window is while the pill is open.
pub fn open_long(dots: usize) -> i32 {
    rest_long(dots).max(pill_long(dots) + 2 * PILL_ROOM.1)
}

/// The dock's window at rest on `edge`, centred along it.
pub fn dock_rect(at: &Place, edge: Edge, dots: usize) -> Rect {
    strip_rect(at, edge, DOCK_DEEP, Some(rest_long(dots)), DOCK_INSET)
}

/// The dock's window: the tab's at rest, and while the pill is open, OPEN_DEEP from the edge and
/// centred on the tab's, so the tab stays where it was.
pub fn window_rect(at: &Place, edge: Edge, dots: usize, open: bool) -> Rect {
    let rest = dock_rect(at, edge, dots);
    if !open {
        return rest;
    }
    let wide = strip_rect(at, edge, OPEN_DEEP, Some(open_long(dots)), DOCK_INSET);
    let dy = (rest.top + rest.bottom - wide.top - wide.bottom) / 2;
    Rect {
        top: wide.top + dy,
        bottom: wide.bottom + dy,
        ..wide
    }
}
