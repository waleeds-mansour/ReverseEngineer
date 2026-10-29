// The agent dock's sizes, in its page's CSS px at 100 % (dockShape.ts keeps the same numbers), and
// the window they make on a monitor. The dock is the notch: one black shape on a side of the
// screen that everything opens inside. At rest it is the edge tab, TAB_DEEP px out from the edge,
// flush with it, whose straight body grows with its dots (a 13 px slot each, 9 px between, 60 px
// for two) between two 22 px S-shaped flares that meet the edge tangentially. Hovered, the same
// shape grows NOTCH_DEEP deep into a column of icons, and grows again toward the middle of the
// screen to hold a panel (notchPanel.ts) of at most PANEL_WIDE with its padding.
// The window is made once at the size of the biggest of these: WINDOW_DEEP from the edge and as
// tall as the work area, so hovering, opening and closing never resize it; only its region changes
// (dockclip.rs). The tab sits anywhere along it, EDGE_ROOM in from the work area's top and bottom
// (dockplace.rs). The owner's size for the dock (SCALES, 150 % to start) zooms the page as a whole,
// and dock.rs's drawn_at folds it into the scale every size here is drawn at.

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
/// How deep the open column is: 40 px circles round 20 px icons, 6 px in from either side.
pub const NOTCH_DEEP: i32 = 52;
/// The biggest panel and the 16 px the notch pads it by on each side (notchPanel.ts's PANEL_MAX
/// and PANEL_PAD).
pub const PANEL_WIDE: i32 = 420 + 2 * 16;
/// Room past the widest panel, for its hairline and a spring's overshoot.
pub const WINDOW_ROOM: i32 = 16;
/// How deep the dock's window is, always.
pub const WINDOW_DEEP: i32 = NOTCH_DEEP + PANEL_WIDE + WINDOW_ROOM;
/// How far inside the work area's top and bottom the notch stays.
pub const EDGE_ROOM: i32 = 12;
/// The sizes the owner can pick for the dock, in percent, and the one it starts at.
pub const SCALES: [u32; 4] = [100, 125, 150, 175];
pub const SCALE: u32 = 150;

/// `dots` slots of `slot` px with `gap` between them; one even with none.
fn slots(dots: usize, slot: i32, gap: i32) -> i32 {
    let n = dots.max(1) as i32;
    n * slot + (n - 1) * gap
}

/// How long the tab is along its edge: its body and both flares.
pub fn tab_long(dots: usize) -> i32 {
    2 * TAB_FLARE + TAB_PAD + slots(dots, TAB_SLOT, TAB_GAP)
}

/// The size the owner picked, as one of SCALES: the nearest, so an odd stored value still reads.
pub fn scale(percent: u32) -> u32 {
    SCALES
        .into_iter()
        .min_by_key(|s| s.abs_diff(percent))
        .unwrap_or(SCALE)
}

/// The zoom the dock's page is drawn at on the work area `at` (at its own DPI) with Windows' text
/// size at `text` percent: the owner's size, unless the window, WINDOW_DEEP CSS px across, would
/// then be wider than the work area, and then as much as fits it, never below 50 %.
pub fn fitting(size: u32, at: &Place, text: u32) -> u32 {
    let (lo, hi) = super::dock::TEXT_SIZES;
    let per = u64::from(at.dpi.max(1)) * u64::from(text.clamp(lo, hi)) * WINDOW_DEEP as u64;
    let most = u64::try_from(at.rect.width().max(0)).unwrap_or(0) * 96 * 10_000 / per;
    scale(size).min(u32::try_from(most).unwrap_or(u32::MAX).max(50))
}

/// The dock's window on `edge` of `at`, the work area as the page is drawn on it: WINDOW_DEEP
/// from the edge and the work area's whole height.
pub fn window_rect(at: &Place, edge: Edge) -> Rect {
    strip_rect(at, edge, WINDOW_DEEP, None, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nook::dock::dock_at;

    #[test]
    fn the_dock_zooms_no_more_than_its_window_fits_the_work_area() {
        let work = |w: i32, dpi: u32| Place {
            rect: Rect {
                left: 0,
                top: 0,
                right: w,
                bottom: 1032,
            },
            dpi,
        };
        assert_eq!(fitting(150, &work(2560, 96), 100), 150, "as it fits");
        assert_eq!(fitting(150, &work(1920, 120), 100), 150);
        // 1080p at 125 % with Windows' text at 225 %: 175 % would be 2.4 screens wide.
        let small = work(1920, 120);
        let zoom = fitting(175, &small, 225);
        assert!(zoom < 175, "{zoom}");
        let window = window_rect(&dock_at(&small, 225, zoom), Edge::Right);
        assert!(window.width() <= 1920, "{}", window.width());
        assert_eq!(fitting(175, &work(200, 240), 225), 50, "never below half");
    }
}
