// Where the agent dock's window is drawn and takes the pointer: its window region. The window is a
// rectangle with room around what it draws, and without a region that room would take clicks
// meant for the windows under it: the strips beside, above and below the edge tab at rest, and most
// of a 384 px wide window while the pill is open. So the window is clipped to what its page draws,
// with CLIP_ROOM around it for its anti-aliased edges, focus rings and the close shadows dock.css
// gives it (a wider shadow would be cut off at the region's edge). At rest that is the tab's own
// outline, its S-shaped flares followed with short straight pieces, and its count badge while
// anything waits. While the pill is open it is the tab too, as it folds into the edge and springs
// back out, and the column with the strip between it and the screen's edge, gaps and all, so the
// pointer never leaves the window between two capsules or as the column slides in from the edge;
// and the status label, as wide as the page says it is and wherever it may be while it glides
// from dot to dot, joined to the column across the gap between them. The sizes are docksize.rs's,
// in CSS px, drawn at the window's scale (dock.rs's drawn_at). What the region covers is also what
// Nook's own watch of the pointer counts as still on the dock (dock.rs's pointer).

use super::chrome::Edge;
use super::dock::DockRun;
use super::docksize::{pill_long, tab_long, LABEL_GAP, PILL_INSET, PILL_WIDE, TAB_DEEP, TAB_FLARE};
use super::probe::Rect;

/// CSS px kept around what the page draws.
pub const CLIP_ROOM: i32 = 3;
/// Above the column, for the Inbox button's badge, which sits 4 px over it with a 2 px ring.
const BADGE_ROOM: i32 = 7;
/// Short straight pieces per flare.
const FLARE_STEPS: u32 = 8;
/// A count badge pops in to a quarter bigger than it settles: 2 px more on each side.
const POP: f64 = 2.0;

/// A piece of the window's region, in physical px from the window's top-left.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Shape {
    Rect(Rect),
    /// A rectangle whose corners are rounded to this radius.
    Round(Rect, i32),
    Polygon(Vec<(i32, i32)>),
}

impl Shape {
    /// The rectangle around it.
    pub fn bounds(&self) -> Rect {
        match self {
            Shape::Rect(r) | Shape::Round(r, _) => *r,
            Shape::Polygon(p) => Rect {
                left: p.iter().map(|q| q.0).min().unwrap_or(0),
                top: p.iter().map(|q| q.1).min().unwrap_or(0),
                right: p.iter().map(|q| q.0).max().unwrap_or(0),
                bottom: p.iter().map(|q| q.1).max().unwrap_or(0),
            },
        }
    }
}

/// The status label as the page last said, in CSS px from the window's top: from `top` to
/// `bottom` while it may be anywhere between two dots, and `wide`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LabelBox {
    pub top: i32,
    pub bottom: i32,
    pub wide: i32,
}

impl LabelBox {
    /// What the page sent: none once the label is gone (0 wide) or for a box that makes no sense.
    pub fn read(top: i32, bottom: i32, wide: i32) -> Option<LabelBox> {
        (wide > 0 && bottom > top).then_some(LabelBox { top, bottom, wide })
    }
}

/// What the region is made from, so it is set again exactly when one of these changes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipKey {
    /// The window's size in physical px.
    pub size: (i32, i32),
    /// The page's scale: the monitor's DPI times Windows' text size (drawn_at).
    pub dpi: u32,
    pub edge: Edge,
    pub dots: usize,
    pub open: bool,
    pub badge: bool,
    pub label: Option<LabelBox>,
}

/// CSS px to the window's physical px, measured in from the screen's edge and down from the
/// window's top or its middle.
struct Frame {
    w: i32,
    h: i32,
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
    /// `y` CSS px below the window's middle, where the page centres the tab and the column.
    fn mid(&self, y: f64) -> i32 {
        (f64::from(self.h) / 2.0 + y * self.s).round() as i32
    }
    /// `y` CSS px below the window's top.
    fn top(&self, y: f64) -> i32 {
        (y * self.s).round() as i32
    }
    fn rect(&self, (d0, d1): (f64, f64), (top, bottom): (i32, i32)) -> Rect {
        let (a, b) = (self.x(d0), self.x(d1));
        Rect {
            left: a.min(b),
            top,
            right: a.max(b),
            bottom,
        }
    }
    fn px(&self, css: f64) -> i32 {
        (css * self.s).round() as i32
    }
}

/// A point on a flare, `t` of the way from the screen's edge to the body: the cubic dockShape.ts
/// draws, with both handles at 85 % of the flare's length, as CSS px in from the edge and down.
fn flare(t: f64) -> (f64, f64) {
    let (f, deep) = (f64::from(TAB_FLARE), f64::from(TAB_DEEP));
    let h = 0.85 * f;
    let u = 1.0 - t;
    let d = 3.0 * u * t * t * deep + t * t * t * deep;
    let y = 3.0 * u * u * t * h + 3.0 * u * t * t * (f - h) + t * t * t * f;
    (d, y)
}

/// The tab's outline, CLIP_ROOM bigger toward the middle and past both ends.
fn tab(fr: &Frame, dots: usize) -> Shape {
    let (m, half) = (f64::from(CLIP_ROOM), f64::from(tab_long(dots)) / 2.0);
    let mut points = vec![(fr.x(0.0), fr.mid(-half - m))];
    let steps = (0..=FLARE_STEPS).map(|i| flare(f64::from(i) / f64::from(FLARE_STEPS)));
    let top: Vec<(f64, f64)> = steps.collect();
    points.extend(top.iter().map(|&(d, y)| (fr.x(d + m), fr.mid(y - half))));
    points.extend(
        top.iter()
            .rev()
            .map(|&(d, y)| (fr.x(d + m), fr.mid(half - y))),
    );
    points.push((fr.x(0.0), fr.mid(half + m)));
    Shape::Polygon(points)
}

/// The tab's count badge: 16 px tall, 15 px down the tab, sticking 8 px out of its side toward
/// the middle, in a 2 px ring, and POP more while it pops in.
fn badge(fr: &Frame, dots: usize) -> Shape {
    let (m, top) = (f64::from(CLIP_ROOM) + POP, -f64::from(tab_long(dots)) / 2.0);
    let far = f64::from(TAB_DEEP + 8 + 2) + m;
    Shape::Rect(fr.rect((0.0, far), (fr.mid(top + 13.0 - m), fr.mid(top + 33.0 + m))))
}

/// The region for `k`, in the window's physical px.
pub fn shapes(k: &ClipKey) -> Vec<Shape> {
    let fr = Frame {
        w: k.size.0,
        h: k.size.1,
        s: f64::from(k.dpi.max(1)) / 96.0,
        left: k.edge == Edge::Left,
    };
    let m = f64::from(CLIP_ROOM);
    let mut all = vec![tab(&fr, k.dots)];
    if k.badge && !k.open {
        all.push(badge(&fr, k.dots));
    }
    if !k.open {
        return all;
    }
    let half = f64::from(pill_long(k.dots)) / 2.0;
    let (inset, wide) = (f64::from(PILL_INSET), f64::from(PILL_WIDE));
    let span = (fr.mid(-half - f64::from(BADGE_ROOM)), fr.mid(half + m));
    // The column, rounded on its far side, and square from there to the screen's edge, taller
    // by the Inbox badge, which may be as wide as the column.
    let column = fr.rect((inset - m, inset + wide + m), (fr.mid(-half - m), span.1));
    all.push(Shape::Round(column, fr.px(wide / 2.0 + m)));
    all.push(Shape::Rect(fr.rect((0.0, inset + wide), span)));
    if let Some(l) = k.label {
        let near = inset + wide + f64::from(LABEL_GAP);
        let (top, bottom) = (f64::from(l.top), f64::from(l.bottom));
        let y = (fr.top(top - m), fr.top(bottom + m));
        let label = fr.rect((near - m, near + f64::from(l.wide) + m), y);
        all.push(Shape::Round(label, fr.px(16.0 + m)));
        // Across the gap to the column, so the pointer can go from a dot to the label.
        let gap = fr.rect((inset + wide, near), (fr.top(top), fr.top(bottom)));
        all.push(Shape::Rect(gap));
    }
    all
}

impl DockRun {
    /// What the window's region is made from now, when it has a place on a monitor.
    fn clip_key(&self) -> Option<ClipKey> {
        let (r, at) = (self.placed?, self.at()?);
        Some(ClipKey {
            size: (r.width(), r.height()),
            dpi: at.dpi,
            edge: self.place.edge,
            dots: self.dots,
            open: self.open,
            badge: self.waiting,
            label: self.label.filter(|_| self.open),
        })
    }

    /// The window's region, when it changed since it was last set, recorded as set. Called after
    /// every plan, so it follows every move, resize and change of scale.
    pub fn clip(&mut self) -> Option<Vec<Shape>> {
        let key = self.clip_key()?;
        if self.clipped == Some(key) {
            return None;
        }
        self.clipped = Some(key);
        Some(shapes(&key))
    }

    /// What the region covers, on the screen: where the pointer still counts as on the dock. The
    /// whole window while there is no region yet.
    pub fn reach(&self) -> Vec<Rect> {
        let (Some(r), Some(key)) = (self.placed, self.clip_key()) else {
            return self.placed.into_iter().collect();
        };
        shapes(&key)
            .iter()
            .map(|s| {
                let b = s.bounds();
                Rect {
                    left: r.left + b.left,
                    top: r.top + b.top,
                    right: r.left + b.right,
                    bottom: r.top + b.bottom,
                }
            })
            .collect()
    }
}

#[cfg(test)]
#[path = "dockclip_tests.rs"]
mod tests;
