// Where the agent dock's window is drawn and takes the pointer: its window region. The window is
// made once, as deep as the biggest panel and as tall as the work area (docksize.rs), and without a
// region all of it would take clicks meant for the windows under it. So it is clipped to what its
// page draws, with CLIP_ROOM around it for anti-aliased edges and the notch's hairline.
// Nook keeps the tab's own piece itself, from where it put the tab: the tab's outline, its S-shaped
// flares followed with short straight pieces, and at rest its count badge while anything waits, a
// rounded box around the badge alone. So the tab takes the pointer before the page has said
// anything, and whatever the page says. Everything else is the page's: the notch's outline as it
// draws it, sent as polygons in CSS px (UiCmd::DockShape). While the notch morphs from one shape
// to another the page sends both outlines and the farthest a spring may overshoot, so the region
// never cuts off what is drawn mid-morph, and once it has settled it sends what it settled on, so
// the region shrinks to that. Nook checks what it is sent: a polygon with a point that isn't a
// number is dropped, and the rest are kept to the window.
// No piece covers what the page leaves unpainted beyond that room. In 1.0.46 a piece did: a 7 px
// strip above the open column, from the edge to the column's far side, kept for a badge that
// wasn't there, showed white while the strip beside the column, in the same piece, showed the
// screen through. That window was resized on every hover, and its webview is moved to the new
// size after the window is, so a piece can show the window's own surface where the webview hasn't
// drawn; the window here is never resized on hover, and the tests hold every piece to the drawn
// outline. The sizes are docksize.rs's, drawn at the window's scale (dock.rs's drawn_at). What the
// region covers is also what Nook's own watch of the pointer counts as still on the dock
// (dock.rs's pointer).

use super::chrome::Edge;
use super::dock::DockRun;
use super::docksize::{tab_long, TAB_DEEP, TAB_FLARE};
use super::probe::Rect;

/// CSS px kept around what the page draws.
pub const CLIP_ROOM: i32 = 3;
/// Short straight pieces per flare.
const FLARE_STEPS: u32 = 8;
/// A count badge pops in to a quarter bigger than it settles: 2 px more on each side.
const POP: f64 = 2.0;
/// The badge on the tab: 16 px tall and up to 32 wide with its 2 px ring, 15 px down the tab, its
/// far side 8 px past the tab's (dock.css).
const BADGE: (f64, f64, f64, f64) = (16.0, 32.0, 15.0, 8.0);
/// The most polygons the page may send, and points in each.
pub const MOST_OUTLINES: usize = 12;
pub const MOST_POINTS: usize = 800;

/// A piece of the window's region, in physical px from the window's top-left.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Shape {
    /// A rectangle whose corners are rounded to this radius.
    Round(Rect, i32),
    Polygon(Vec<(i32, i32)>),
}

impl Shape {
    /// The rectangle around it.
    #[cfg(test)]
    pub fn bounds(&self) -> Rect {
        match self {
            Shape::Round(r, _) => *r,
            Shape::Polygon(p) => Rect {
                left: p.iter().map(|q| q.0).min().unwrap_or(0),
                top: p.iter().map(|q| q.1).min().unwrap_or(0),
                right: p.iter().map(|q| q.0).max().unwrap_or(0),
                bottom: p.iter().map(|q| q.1).max().unwrap_or(0),
            },
        }
    }

    /// Whether the point, in the window's physical px, is in it, as Windows fills it: a polygon
    /// by its winding number, so a point inside any loop of it counts.
    pub fn contains(&self, x: i32, y: i32) -> bool {
        match self {
            Shape::Round(r, _) => r.contains_point(x, y),
            Shape::Polygon(p) => winding(p, f64::from(x) + 0.5, f64::from(y) + 0.5) != 0,
        }
    }
}

/// How many times the polygon winds round the point.
fn winding(p: &[(i32, i32)], x: f64, y: f64) -> i32 {
    let mut n = 0;
    for (i, &(x0, y0)) in p.iter().enumerate() {
        let (x1, y1) = p[(i + 1) % p.len()];
        let (x0, y0, x1, y1) = (f64::from(x0), f64::from(y0), f64::from(x1), f64::from(y1));
        let side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
        if y0 <= y && y1 > y && side > 0.0 {
            n += 1;
        } else if y0 > y && y1 <= y && side < 0.0 {
            n -= 1;
        }
    }
    n
}

/// What the region is made from, in the window's physical px and the page's CSS px.
#[derive(Clone, Debug, PartialEq)]
pub struct ClipKey {
    /// The window's size in physical px.
    pub size: (i32, i32),
    /// The page's scale: the monitor's DPI times Windows' text size and the dock's size.
    pub dpi: u32,
    pub edge: Edge,
    pub dots: usize,
    /// The tab's middle, in CSS px down the window, as the page is told it.
    pub mid: i32,
    /// The count badge beside the tab at rest: anything waits, and the notch is folded.
    pub badge: bool,
    /// While the tab is dragged, its middle a move ago, where the page may still draw it.
    pub trail: Option<i32>,
    /// The page's outlines, CSS px from the window's top-left.
    pub outlines: Vec<Vec<(f64, f64)>>,
}

/// CSS px to the window's physical px, measured in from the screen's edge and down from the
/// tab's middle.
struct Frame {
    w: i32,
    centre: f64,
    s: f64,
    left: bool,
}

impl Frame {
    fn x(&self, d: f64) -> i32 {
        let px = (d * self.s).round() as i32;
        if self.left {
            px
        } else {
            self.w - px
        }
    }
    /// `y` CSS px below the tab's middle.
    fn mid(&self, y: f64) -> i32 {
        (self.centre + y * self.s).round() as i32
    }
}

/// A point on a flare, `t` of the way from the screen's edge to the body: the cubic dockShape.ts
/// draws, with both handles at 85 % of the flare's length, as CSS px in from the edge and down.
pub fn flare(t: f64) -> (f64, f64) {
    let (f, deep) = (f64::from(TAB_FLARE), f64::from(TAB_DEEP));
    let h = 0.85 * f;
    let u = 1.0 - t;
    let d = 3.0 * u * t * t * deep + t * t * t * deep;
    let y = 3.0 * u * u * t * h + 3.0 * u * t * t * (f - h) + t * t * t * f;
    (d, y)
}

/// The tab's outline, CLIP_ROOM bigger all round: each flare's points move CLIP_ROOM toward the
/// middle of the screen and CLIP_ROOM away from the tab's middle, so even where a flare runs
/// nearly across the edge it keeps that room.
fn tab(fr: &Frame, dots: usize) -> Shape {
    let (m, half) = (f64::from(CLIP_ROOM), f64::from(tab_long(dots)) / 2.0);
    let mut points = vec![(fr.x(0.0), fr.mid(-half - m))];
    let steps = (0..=FLARE_STEPS).map(|i| flare(f64::from(i) / f64::from(FLARE_STEPS)));
    let top: Vec<(f64, f64)> = steps.collect();
    points.extend(
        top.iter()
            .map(|&(d, y)| (fr.x(d + m), fr.mid(y - half - m))),
    );
    points.extend(
        top.iter()
            .rev()
            .map(|&(d, y)| (fr.x(d + m), fr.mid(half - y + m))),
    );
    points.push((fr.x(0.0), fr.mid(half + m)));
    Shape::Polygon(points)
}

/// The tab's count badge as wide as it gets, with its ring and CLIP_ROOM, and POP more while it
/// pops in: a rounded box round the badge alone, over the tab where it overlaps it.
fn badge(fr: &Frame, dots: usize) -> Shape {
    let (tall, wide, down, past) = BADGE;
    let m = f64::from(CLIP_ROOM) + POP;
    let top = -f64::from(tab_long(dots)) / 2.0 + down - 2.0;
    let far = f64::from(TAB_DEEP) + past + 2.0;
    let (a, b) = (fr.x((far - wide - m).max(0.0)), fr.x(far + m));
    let r = Rect {
        left: a.min(b),
        top: fr.mid(top - m),
        right: a.max(b),
        bottom: fr.mid(top + tall + 4.0 + m),
    };
    Shape::Round(r, ((tall / 2.0 + 2.0 + m) * fr.s).round() as i32)
}

/// The page's outlines in the window's physical px: at most MOST_OUTLINES of at most MOST_POINTS
/// each, any with a point that isn't a number dropped, and every point kept to the window.
fn outlines(k: &ClipKey, s: f64) -> Vec<Shape> {
    let (w, h) = (f64::from(k.size.0), f64::from(k.size.1));
    k.outlines
        .iter()
        .take(MOST_OUTLINES)
        .filter(|p| (3..=MOST_POINTS).contains(&p.len()))
        .filter(|p| p.iter().all(|q| q.0.is_finite() && q.1.is_finite()))
        .map(|p| {
            let at = |v: f64, most: f64| (v * s).round().clamp(0.0, most) as i32;
            Shape::Polygon(p.iter().map(|&(x, y)| (at(x, w), at(y, h))).collect())
        })
        .collect()
}

/// The region for `k`, in the window's physical px.
pub fn shapes(k: &ClipKey) -> Vec<Shape> {
    let s = f64::from(k.dpi.max(1)) / 96.0;
    let fr = Frame {
        w: k.size.0,
        centre: f64::from(k.mid) * s,
        s,
        left: k.edge == Edge::Left,
    };
    let mut all = vec![tab(&fr, k.dots)];
    if let Some(t) = k.trail.filter(|&t| t != k.mid) {
        let was = Frame {
            centre: f64::from(t) * s,
            ..fr
        };
        all.push(tab(&was, k.dots));
    }
    if k.badge {
        all.push(badge(&fr, k.dots));
    }
    all.extend(outlines(k, s));
    all
}

impl DockRun {
    /// What the window's region is made from now, when it has a place on a monitor.
    pub fn clip_key(&self) -> Option<ClipKey> {
        let (r, at, mid) = (self.placed?, self.at()?, self.mid()?);
        Some(ClipKey {
            size: (r.width(), r.height()),
            dpi: at.dpi,
            edge: self.place.edge,
            dots: self.dots,
            mid,
            badge: self.waiting && !self.open && !self.hold,
            trail: self.trail.filter(|_| self.drag.is_some()),
            outlines: self.outlines.clone(),
        })
    }

    /// The window's region, when it changed since it was last set, recorded as set. Called after
    /// every plan, so it follows every move, resize, change of scale and outline from the page.
    pub fn clip(&mut self) -> Option<Vec<Shape>> {
        let all = shapes(&self.clip_key()?);
        if self.clipped.as_ref() == Some(&all) {
            return None;
        }
        self.clipped = Some(all.clone());
        Some(all)
    }

    /// Whether the pointer, in physical px on the screen, is where the region takes it: on the
    /// dock, for Nook's own watch. Anywhere on the window while there is no region yet.
    pub fn covers(&self, cursor: Option<(i32, i32)>) -> bool {
        let (Some(r), Some((x, y))) = (self.placed, cursor) else {
            return false;
        };
        match self.clip_key() {
            Some(key) => shapes(&key)
                .iter()
                .any(|s| s.contains(x - r.left, y - r.top)),
            None => r.contains_point(x, y),
        }
    }
}

#[cfg(test)]
#[path = "dockclip_tests.rs"]
mod tests;
