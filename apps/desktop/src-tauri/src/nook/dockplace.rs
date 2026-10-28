// Where the agent dock sits: which side of the primary monitor, and how far down it. The owner
// picks the side in Nook's panel or the dock's own menu, and drags the edge tab along it; each side
// keeps its own spot, as the fraction of the edge's length where the tab's middle is, so the tab
// comes back to the same place after a resolution or monitor change. It starts on the right edge,
// halfway down, and goes no higher or lower than leaves room for its open pill, which opens
// centred on it, within the monitor's work area (usable), so never under the taskbar. Unlike Nook's
// switches, where the dock sits turns nothing on, so a stored
// value that doesn't read is simply the defaults, and the rest of Nook carries on. It is kept in
// the settings store under a key of its own, next to Nook's switches.

use super::bar::Place;
use super::chrome::Edge;
use super::docksize::{dock_rect, window_rect};
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

/// The monitor as the dock may use it: as tall as its work area, so the open pill never reaches
/// under the taskbar, and as wide as the monitor, so the tab stays flush with the screen's edge.
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

/// The tops the resting window may have on `at`: as high as leaves the open pill's window, which
/// reaches above it, on the monitor, down to as low as does the same below. The room is kept
/// whether or not the pill is open, so opening it never moves the tab.
fn tops(at: &Place, edge: Edge, dots: usize) -> (i32, i32) {
    let m = at.rect;
    let rest = dock_rect(at, edge, dots);
    let open = window_rect(at, edge, dots, true);
    let above = (rest.top - open.top).max(0);
    let below = open.bottom.max(rest.bottom) - rest.top;
    let lo = m.top + above;
    (lo, (m.bottom - below).max(lo))
}

/// The resting window's top for `along`, kept where it and its open pill stay on the monitor.
/// Halfway down is exactly where dock_rect centres it.
pub fn top_at(at: &Place, edge: Edge, dots: usize, along: f64) -> i32 {
    let (m, rest) = (at.rect, dock_rect(at, edge, dots));
    let long = f64::from(rest.bottom - rest.top);
    let height = f64::from(m.bottom - m.top);
    // The small nudge keeps a top read back from its own fraction from landing a pixel short.
    let top = m.top + (fraction(along) * height - long / 2.0 + 1e-6).floor() as i32;
    let (lo, hi) = tops(at, edge, dots);
    top.clamp(lo, hi)
}

/// How far down the edge a resting window with its top at `top` is, once kept on the monitor.
pub fn along_at(at: &Place, edge: Edge, dots: usize, top: i32) -> f64 {
    let (m, rest) = (at.rect, dock_rect(at, edge, dots));
    let height = m.bottom - m.top;
    if height <= 0 {
        return 0.5;
    }
    let (lo, hi) = tops(at, edge, dots);
    let middle = f64::from(top.clamp(lo, hi) - m.top) + f64::from(rest.bottom - rest.top) / 2.0;
    fraction(middle / f64::from(height))
}

/// The dock's window where `along` puts the tab: window_rect's, moved along the edge.
pub fn window_at(at: &Place, edge: Edge, dots: usize, open: bool, along: f64) -> Rect {
    let r = window_rect(at, edge, dots, open);
    let dy = top_at(at, edge, dots, along) - dock_rect(at, edge, dots).top;
    Rect {
        top: r.top + dy,
        bottom: r.bottom + dy,
        ..r
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
