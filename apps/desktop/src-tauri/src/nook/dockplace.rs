// Where the agent dock sits: which side of the primary monitor, and how far down it. The owner
// picks the side in Nook's panel or the dock's own menu, and drags the edge tab along it; each side
// keeps its own spot, as the fraction of the edge's length where the tab's middle is, so the tab
// comes back to the same place after a resolution or monitor change. It starts on the right edge,
// halfway down, and the whole tab stays EDGE_ROOM inside the monitor's work area (usable), so never
// under the taskbar. Its window fills that height, so dragging moves only the tab, not the window.
// Unlike Nook's switches, where the dock sits turns nothing on, so a stored value that doesn't read
// is simply the defaults, and the rest of Nook carries on. It is kept in the settings store under a
// key of its own, next to Nook's switches.

use super::bar::Place;
use super::chrome::Edge;
use super::dock::DockRun;
use super::docksize::{tab_long, EDGE_ROOM};
use super::probe::Rect;
use log::warn;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// The key in settings_store.json.
pub const PLACE_KEY: &str = "nook_dock_place";

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DockPlace {
    /// The side it sits on; the top is the bar's, so it reads as the right.
    pub edge: Edge,
    /// How far down the left edge the tab's middle is: 0 at the top, 1 at the bottom.
    pub left: f64,
    /// The same on the right edge.
    pub right: f64,
}

impl Default for DockPlace {
    fn default() -> DockPlace {
        DockPlace {
            edge: Edge::Right,
            left: 0.5,
            right: 0.5,
        }
    }
}

impl DockPlace {
    /// How far down its own side the tab is.
    pub fn along(&self) -> f64 {
        match self.edge {
            Edge::Left => self.left,
            _ => self.right,
        }
    }

    /// The same place, `along` its own side.
    pub fn moved(self, along: f64) -> DockPlace {
        let along = fraction(along);
        match self.edge {
            Edge::Left => DockPlace {
                left: along,
                ..self
            },
            _ => DockPlace {
                right: along,
                ..self
            },
        }
    }

    /// The other side's spot, or this one's, on `edge`.
    pub fn on(self, edge: Edge) -> DockPlace {
        DockPlace {
            edge: side(edge),
            ..self
        }
    }

    fn clean(self) -> DockPlace {
        DockPlace {
            edge: side(self.edge),
            left: fraction(self.left),
            right: fraction(self.right),
        }
    }
}

/// The side the dock sits on for `edge`: the left, or else the right.
pub fn side(edge: Edge) -> Edge {
    if edge == Edge::Left {
        Edge::Left
    } else {
        Edge::Right
    }
}

fn fraction(f: f64) -> f64 {
    if f.is_finite() {
        f.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

/// The monitor as the dock may use it: as tall as its work area, so the notch never reaches under
/// the taskbar, and as wide as the monitor, so the tab stays flush with the screen's edge.
/// The monitor itself when there is no work area, or one that doesn't fit it.
pub fn usable(at: &Place, work: Option<Rect>) -> Place {
    let m = at.rect;
    match work {
        Some(w) if w.top >= m.top && w.bottom <= m.bottom && w.bottom > w.top => Place {
            rect: Rect {
                top: w.top,
                bottom: w.bottom,
                ..m
            },
            dpi: at.dpi,
        },
        _ => *at,
    }
}

/// The lowest and highest the tab's middle may be, in physical px down `at`: where the whole tab
/// is EDGE_ROOM inside it. The open column and its panels keep inside it on their own (the page
/// slides them along the edge when the tab is near an end), so they need no room kept here.
fn mids(at: &Place, dots: usize) -> (i32, i32) {
    let s = f64::from(at.dpi.max(1)) / 96.0;
    let half = ((f64::from(tab_long(dots)) / 2.0 + f64::from(EDGE_ROOM)) * s).round() as i32;
    let height = at.rect.height().max(0);
    let lo = half.min(height / 2);
    (lo, (height - half).max(lo))
}

/// The tab's middle for `along`, in physical px down `at`, the work area its window fills, kept
/// where the whole tab stays on it.
pub fn mid_at(at: &Place, dots: usize, along: f64) -> i32 {
    let (lo, hi) = mids(at, dots);
    // The small nudge keeps a middle read back from its own fraction from landing a pixel short.
    let mid = (fraction(along) * f64::from(at.rect.height()) + 1e-6).floor() as i32;
    mid.clamp(lo, hi)
}

/// How far down the edge a tab whose middle is `mid` px down `at` is, once kept on it.
pub fn along_at(at: &Place, dots: usize, mid: i32) -> f64 {
    let height = at.rect.height();
    if height <= 0 {
        return 0.5;
    }
    let (lo, hi) = mids(at, dots);
    fraction(f64::from(mid.clamp(lo, hi)) / f64::from(height))
}

impl DockRun {
    /// The tab's middle where it is now, in physical px down its window.
    pub fn mid_px(&self) -> Option<i32> {
        let at = self.at()?;
        Some(mid_at(&at, self.dots, self.place.along()))
    }

    /// Moves it to `edge`, at that side's own spot. The place to keep.
    pub fn move_to(&mut self, edge: Edge) -> DockPlace {
        self.place = self.place.on(edge);
        self.open = false;
        self.place
    }

    /// The tab or the open notch was pressed and moved with the pointer at height `y`: from now
    /// the tab follows the pointer along its edge, with the notch folded. Whether it can (it
    /// shows, where it was put). The window stays where it is; only the tab moves down it.
    pub fn drag_start(&mut self, y: i32) -> bool {
        let (Some(_), Some(mid)) = (self.placed.filter(|_| self.visible()), self.mid_px()) else {
            return false;
        };
        self.drag = Some((mid, y));
        self.trail = None;
        self.open = false;
        true
    }

    /// The pointer is at height `y` while dragging: the tab moves with it, kept on the work area.
    /// Whether it moved.
    pub fn drag_to(&mut self, y: i32) -> bool {
        let (Some((mid, from)), Some(at)) = (self.drag, self.at()) else {
            return false;
        };
        let along = along_at(&at, self.dots, mid + y - from);
        let (was, drawn) = (self.place, self.mid());
        self.place = self.place.moved(along);
        let moved = self.place != was;
        if moved {
            // The page draws the tab where it was until it hears this: the region keeps both.
            self.trail = drawn;
        }
        moved
    }

    /// The button came up: the place to keep, if it was being dragged.
    pub fn drag_end(&mut self) -> Option<DockPlace> {
        self.trail = None;
        self.drag.take().map(|_| self.place)
    }
}

/// Where the dock sits as stored; the defaults when nothing is, or what is doesn't read.
pub fn load(app: &AppHandle) -> DockPlace {
    let path = crate::portable::store_path(crate::settings::SETTINGS_STORE_PATH);
    match app.store(path) {
        Ok(store) => from_value(store.get(PLACE_KEY)),
        Err(e) => {
            warn!("Couldn't open the settings store for the dock's place: {e}");
            DockPlace::default()
        }
    }
}

pub fn save(app: &AppHandle, place: DockPlace) -> Result<(), String> {
    let path = crate::portable::store_path(crate::settings::SETTINGS_STORE_PATH);
    let value = serde_json::to_value(place.clean()).map_err(|e| e.to_string())?;
    app.store(path)
        .map_err(|e| e.to_string())?
        .set(PLACE_KEY, value);
    Ok(())
}

pub fn from_value(value: Option<serde_json::Value>) -> DockPlace {
    value
        .and_then(|v| serde_json::from_value::<DockPlace>(v).ok())
        .unwrap_or_default()
        .clean()
}

#[cfg(test)]
#[path = "dockplace_tests.rs"]
mod tests;
