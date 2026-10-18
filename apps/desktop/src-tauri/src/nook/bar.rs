// What Nook's bar and popover should be doing (docs/nook-wm.md, "The Nook bar"), decided without
// touching a window so it can be tested anywhere; barwin.rs carries the decisions out. The bar is
// a strip of bar-height along the top of DISPLAY1 (display2=leave) in Overlay mode: it reserves no
// space and isn't topmost. It is shown once its page has drawn and only while Nook observes, so it
// always knows when a game or something fullscreen is in front: on DISPLAY1 it hides, and on
// another monitor it stays up but holds still, with its popover closed. The popover is
// made with the bar and kept hidden and suspended until the bar asks for it. Turning the bar off
// destroys both, and the observer it kept running stops unless the panel or its own switch wants it.

use super::chrome::BarView;
use super::probe::{Hwnd, Rect};
use super::start::Status;
use super::view::{FrontWindow, ModeName, NookState, RectView};

pub const BAR_LABEL: &str = "nook_bar_1";
pub const POPOVER_LABEL: &str = "nook_popover";
pub const BAR_PAGE: &str = "src/nook/bar.html";
pub const POPOVER_PAGE: &str = "src/nook/popover.html";
/// bar-height in design/nook/tokens.json, in logical px.
pub const BAR_HEIGHT: i32 = 28;
/// The popover's window in logical px: popover.css's 280 px card with room for its shadow.
pub const POPOVER_SIZE: (i32, i32) = (304, 236);
/// How far the popover sits from the screen's right edge, in logical px, under the bar.
const POPOVER_EDGE: i32 = 8;

/// Whether the bar should exist, or why not. The disabled file and safe start stop it as they
/// stop observing; a fault in an observing thread stops it until Hearth starts again, since
/// without the observer it couldn't hide over a game.
pub fn wanted(on: bool, status: Status, faulted: bool) -> Result<(), &'static str> {
    match status {
        Status::Disabled => return Err("Nook is turned off by the disabled file in its folder"),
        Status::SafeStart => {
            return Err("Safe start: Nook stopped unexpectedly twice, so the bar stays off")
        }
        Status::Off | Status::NotInThisVersion => {}
    }
    if faulted {
        return Err("The bar stopped after a problem in Nook; nook.log says more");
    }
    if !on {
        return Err("The bar is off");
    }
    Ok(())
}

/// A monitor to put the bar on, in physical px.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Place {
    pub rect: Rect,
    pub dpi: u32,
}

fn scaled(px: i32, dpi: u32) -> i32 {
    (f64::from(px) * f64::from(dpi.max(1)) / 96.0).round() as i32
}

/// The bar: the monitor's full width, bar-height times its scale, at its top-left corner.
pub fn bar_rect(at: &Place) -> Rect {
    let m = at.rect;
    Rect {
        left: m.left,
        top: m.top,
        right: m.right,
        bottom: m.top + scaled(BAR_HEIGHT, at.dpi),
    }
}

/// The popover: under the bar, near the right edge, where the services and Pip sit.
pub fn popover_rect(at: &Place) -> Rect {
    let m = at.rect;
    let (w, h) = (
        scaled(POPOVER_SIZE.0, at.dpi),
        scaled(POPOVER_SIZE.1, at.dpi),
    );
    let right = m.right - scaled(POPOVER_EDGE, at.dpi);
    let top = bar_rect(at).bottom;
    Rect {
        left: (right - w).max(m.left),
        top,
        right,
        bottom: (top + h).min(m.bottom),
    }
}

fn rect_of(r: &RectView) -> Rect {
    Rect {
        left: r.x,
        top: r.y,
        right: r.x + r.width,
        bottom: r.y + r.height,
    }
}

/// Whether `window` covers all of `monitor`, as a fullscreen window or one stretched past it does.
fn covers(window: &Rect, monitor: &Rect) -> bool {
    window.left <= monitor.left
        && window.top <= monitor.top
        && window.right >= monitor.right
        && window.bottom >= monitor.bottom
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Which {
    Bar,
    Popover,
}

/// One thing to do to Nook's own windows, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Place {
        bar: Rect,
        popover: Rect,
    },
    /// Its webview is visible again, at normal memory, and gets the latest state.
    Wake(Which),
    /// Shown without taking the foreground.
    Show(Which),
    Hide(Which),
    /// Its webview is invisible, at low memory, and asked to suspend.
    Sleep(Which),
    /// One WM_NCACTIVATE, so a window that is never activated keeps its acrylic.
    NcActivate,
}

/// The bar's side of Nook, under Shared's lock.
#[derive(Debug, Default)]
pub struct BarRun {
    /// The owner's switch, as last read or saved.
    pub setting: bool,
    pub why_not: Option<&'static str>,
    /// The bar and popover windows exist.
    pub made: bool,
    pub bar_drawn: bool,
    pub popover_drawn: bool,
    /// The bar's and popover's own windows, once made.
    pub ours: Vec<Hwnd>,
    /// What the latest NookState said.
    pub observing: bool,
    /// The game guard tripped, for a window on any monitor: Pip holds still and the popover
    /// closes.
    pub game_anywhere: bool,
    /// It tripped for a window on the bar's monitor, or one Nook can't place: the bar hides.
    pub game_here: bool,
    /// The window in front covers the bar's whole monitor, fullscreen or not: the bar hides.
    pub covered: bool,
    pub monitor: Option<Place>,
    /// The window that was in front before the bar or popover, to hand the foreground back to:
    /// one of Hearth's own windows counts.
    pub before: Option<FrontWindow>,
    /// The bar asked for the popover.
    pub popover_wanted: bool,
    // What was last carried out.
    pub shown: bool,
    pub popover_shown: bool,
    pub bar_asleep: bool,
    pub popover_asleep: bool,
    pub placed: Option<Place>,
    pub nc_activated: bool,
    /// The windows were made a second time because the bar's page didn't draw the first.
    pub remade: bool,
}

impl BarRun {
    pub fn bar_visible(&self) -> bool {
        self.made
            && self.bar_drawn
            && self.observing
            && !self.game_here
            && !self.covered
            && self.monitor.is_some()
    }

    /// The popover may open: the bar is up and no game is in front anywhere.
    pub fn popover_allowed(&self) -> bool {
        self.bar_visible() && !self.game_anywhere
    }

    pub fn popover_visible(&self) -> bool {
        self.popover_allowed() && self.popover_wanted && self.popover_drawn
    }

    /// Reads what a new state means for the bar. The popover closes when another app comes to
    /// the front. The bar goes on the primary monitor that is there now: one that was missing
    /// long enough for Nook to stop arranging it still gets its bar back when it returns.
    pub fn take(&mut self, state: &NookState) {
        self.observing = state.mode == ModeName::Observing;
        let primary = state.monitors.iter().find(|m| m.primary);
        self.monitor = primary.map(|m| Place {
            rect: rect_of(&m.rect),
            dpi: m.dpi,
        });
        self.game_anywhere = state.gates.iter().any(|g| g.name == "game_guard")
            || state.focused.as_ref().is_some_and(|f| f.game);
        // The guard judges the window in front; only one on another monitor leaves the bar up.
        let elsewhere = match (state.front.and_then(|f| f.monitor), primary) {
            (Some(on), Some(m)) => on != m.rect,
            _ => false,
        };
        self.game_here = self.game_anywhere && !elsewhere;
        let front = state.front.filter(|f| !self.ours.contains(&f.hwnd));
        self.covered = match (front, self.monitor) {
            (Some(FrontWindow { rect: Some(r), .. }), Some(at)) => covers(&rect_of(&r), &at.rect),
            _ => false,
        };
        if let Some(front) = front {
            if self.before.is_some_and(|b| b.hwnd != front.hwnd) {
                self.popover_wanted = false;
            }
            self.before = Some(front);
        }
        if !self.popover_allowed() {
            self.popover_wanted = false;
        }
    }

    /// The steps that bring the windows to what they should be, recorded as done.
    pub fn plan(&mut self) -> Vec<Step> {
        let mut steps = Vec::new();
        if !self.made {
            return steps;
        }
        if let Some(at) = self.monitor.filter(|m| self.placed != Some(*m)) {
            steps.push(Step::Place {
                bar: bar_rect(&at),
                popover: popover_rect(&at),
            });
            self.placed = Some(at);
        }
        let (bar, popover) = (self.bar_visible(), self.popover_visible());
        if !popover && self.popover_shown {
            steps.push(Step::Hide(Which::Popover));
            self.popover_shown = false;
        }
        if !popover && self.popover_drawn && !self.popover_asleep {
            steps.push(Step::Sleep(Which::Popover));
            self.popover_asleep = true;
        }
        if !bar && self.shown {
            steps.push(Step::Hide(Which::Bar));
            self.shown = false;
        }
        if !bar && self.bar_drawn && !self.bar_asleep {
            steps.push(Step::Sleep(Which::Bar));
            self.bar_asleep = true;
        }
        if bar && !self.shown {
            if self.bar_asleep {
                steps.push(Step::Wake(Which::Bar));
                self.bar_asleep = false;
            }
            steps.push(Step::Show(Which::Bar));
            self.shown = true;
            if !self.nc_activated {
                steps.push(Step::NcActivate);
                self.nc_activated = true;
            }
        }
        if popover && !self.popover_shown {
            if self.popover_asleep {
                steps.push(Step::Wake(Which::Popover));
                self.popover_asleep = false;
            }
            steps.push(Step::Show(Which::Popover));
            self.popover_shown = true;
        }
        steps
    }

    /// The bar's page didn't draw in time. Some(true): make both windows again, which this has
    /// started by forgetting them; Some(false): it was made again already, so it stays hidden,
    /// saying why. None when there is nothing to do.
    pub fn undrawn(&mut self) -> Option<bool> {
        if !self.made || self.bar_drawn {
            return None;
        }
        if self.remade {
            self.why_not = Some("The bar's page didn't draw; nook.log says more");
            return Some(false);
        }
        *self = BarRun {
            setting: self.setting,
            remade: true,
            ..BarRun::default()
        };
        Some(true)
    }

    /// Whether a page should be sent events now: a suspended one would only be woken by them,
    /// and gets the latest when it wakes.
    pub fn receives(&self, label: &str) -> bool {
        match label {
            BAR_LABEL => !self.bar_asleep,
            POPOVER_LABEL => !self.popover_asleep,
            _ => true,
        }
    }

    pub fn view(&self) -> BarView {
        BarView {
            on: self.setting,
            shown: self.shown,
            why_not: if self.setting {
                self.why_not.map(str::to_string)
            } else {
                None
            },
            popover: self.popover_wanted,
            quiet: self.game_anywhere,
        }
    }
}

#[cfg(test)]
#[path = "bar_tests.rs"]
mod tests;
