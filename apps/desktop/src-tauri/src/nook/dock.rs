// What the agent dock should be doing, decided without touching a window so it can be tested
// anywhere; dockwin.rs carries the decisions out. The dock is a short strip of status dots on the
// left edge of the primary monitor, centred top to bottom, topmost and never activated: a dot for
// Pip and one for each of Hearth's services that needs the owner (agents.rs). It is made with its
// switch, which starts on, and shown once its page says it drew (the readiness handshake: a page
// that never says so is made again once). Over something fullscreen or a game it hides: Windows'
// own notification state says when, and while Nook observes for the bar or the panel, nook-wm's
// game guard and the window in front say it too, monitor by monitor. Hovering it opens a
// card beside the strip with the hovered dot's label and last line. The disabled file and safe
// start keep it off, as they keep the bar off. It needs no hook and no observer of its own.

use super::bar::{beside_rect, in_front, strip_rect, Place};
use super::chrome::{DockView, Edge};
use super::probe::{Hwnd, Rect};
use super::start::Status;
use super::view::{ModeName, NookState};

pub const DOCK_LABEL: &str = "nook_dock";
pub const DOCK_PAGE: &str = "src/nook/dock.html";
/// dock-width in dock.css: how deep the strip is from its edge, in logical px.
pub const DOCK_DEEP: i32 = 28;
/// How far the strip floats in from the screen's edge.
pub const DOCK_INSET: i32 = 6;
/// Room above the first dot and below the last.
pub const DOCK_PAD: i32 = 6;
/// Each dot's row.
pub const DOT_ROW: i32 = 24;
/// The hover card beside the strip, with room for its shadow.
pub const CARD_SIZE: (i32, i32) = (248, 72);

/// Whether the dock should exist, or why not. It needs no observer, so a fault in one doesn't
/// stop it.
pub fn wanted(on: bool, status: Status) -> Result<(), &'static str> {
    match status {
        Status::Disabled => Err("Nook is turned off by the disabled file in its folder"),
        Status::SafeStart => {
            Err("Safe start: Nook stopped unexpectedly twice, so the dock stays off")
        }
        Status::Off | Status::NotInThisVersion if !on => Err("The dock is off"),
        Status::Off | Status::NotInThisVersion => Ok(()),
    }
}

/// How long the strip is for `dots` dots, in logical px; one row even with none.
pub fn strip_long(dots: usize) -> i32 {
    2 * DOCK_PAD + DOT_ROW * (dots.max(1) as i32)
}

/// The strip on `edge`, centred along it.
pub fn dock_rect(at: &Place, edge: Edge, dots: usize) -> Rect {
    strip_rect(at, edge, DOCK_DEEP, Some(strip_long(dots)), DOCK_INSET)
}

/// The dock's window: the strip, and while it is open, the card's room beside it as well, as
/// tall as the strip or the card, whichever is taller. The strip stays where it was.
pub fn window_rect(at: &Place, edge: Edge, dots: usize, open: bool) -> Rect {
    let strip = dock_rect(at, edge, dots);
    if !open {
        return strip;
    }
    let tall = strip_long(dots).max(CARD_SIZE.1);
    let card = beside_rect(at, edge, &strip, (CARD_SIZE.0, tall));
    Rect {
        left: strip.left.min(card.left),
        top: strip.top,
        right: strip.right.max(card.right),
        bottom: strip.bottom.max(card.bottom),
    }
}

/// Whether Windows' notification state (SHQueryUserNotificationState) says something fullscreen
/// is in front, a presentation is on, or nobody is there to see the dock.
pub fn busy(quns: i32) -> bool {
    // QUNS_NOT_PRESENT, _BUSY, _RUNNING_D3D_FULL_SCREEN, _PRESENTATION_MODE and _APP; not
    // _ACCEPTS_NOTIFICATIONS or _QUIET_TIME.
    matches!(quns, 1..=4 | 7)
}

/// One thing to do to the dock's window, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DockStep {
    Place(Rect),
    /// Its webview is visible again, at normal memory, and gets the latest state.
    Wake,
    /// Shown topmost, without taking the foreground.
    Show,
    Hide,
    /// Its webview is invisible, at low memory, and asked to suspend.
    Sleep,
}

/// The dock's side of Nook, under Shared's lock.
#[derive(Debug, Default)]
pub struct DockRun {
    /// The owner's switch, as last read or saved.
    pub setting: bool,
    pub why_not: Option<&'static str>,
    /// The window exists.
    pub made: bool,
    /// Its page said it drew its first frame.
    pub drawn: bool,
    pub ours: Vec<Hwnd>,
    pub edge: Edge,
    /// How many dots the page shows.
    pub dots: usize,
    /// The pointer is over the dock, so its card has room.
    pub open: bool,
    /// The primary monitor: nook-wm's while it observes, otherwise as the dock read it.
    pub monitor: Option<Place>,
    /// What the latest NookState said.
    pub observing: bool,
    /// Windows says something fullscreen is in front (busy above).
    pub busy: bool,
    /// While observing: the game guard tripped for a window on the dock's monitor.
    pub game_here: bool,
    /// While observing: the window in front covers the dock's monitor.
    pub covered: bool,
    // What was last carried out.
    pub shown: bool,
    pub asleep: bool,
    pub placed: Option<Rect>,
    /// The window was made a second time because its page didn't draw the first.
    pub remade: bool,
}

impl DockRun {
    pub fn new(setting: bool) -> DockRun {
        DockRun {
            setting,
            ..DockRun::default()
        }
    }

    /// Something in front hides it: Windows' reading always, and nook-wm's verdict too while it
    /// observes. nook-wm alone would miss a window going fullscreen in place (F11, a video) unless
    /// the bar has it following the window in front.
    fn in_the_way(&self) -> bool {
        self.busy || (self.observing && (self.game_here || self.covered))
    }

    pub fn visible(&self) -> bool {
        self.made && self.drawn && self.monitor.is_some() && !self.in_the_way()
    }

    /// What decides where the window goes and whether it shows, to tell when that changed.
    pub fn seen(&self) -> (bool, Option<Place>, usize, bool) {
        (self.visible(), self.monitor, self.dots, self.open)
    }

    /// A state from nook-wm. While it observes, its primary monitor and what is in front of it
    /// count; once it stops, the dock's own readings do again.
    pub fn take(&mut self, state: &NookState) {
        self.observing = state.mode == ModeName::Observing;
        if !self.observing {
            self.game_here = false;
            self.covered = false;
            return;
        }
        let seen = in_front(state, &self.ours);
        if seen.monitor.is_some() {
            self.monitor = seen.monitor;
        }
        self.game_here = seen.game_here;
        self.covered = seen.covered;
        self.open = self.open && self.visible();
    }

    /// The dock's own reading of Windows, every few seconds. Its monitor counts only while
    /// nook-wm isn't observing.
    pub fn read(&mut self, busy: bool, monitor: Option<Place>) {
        self.busy = busy;
        if !self.observing && monitor.is_some() {
            self.monitor = monitor;
        }
        self.open = self.open && self.visible();
    }

    /// The pointer came over the dock, or left it.
    pub fn hover(&mut self, open: bool) {
        self.open = open && self.visible();
    }

    /// The steps that bring the window to what it should be, recorded as done.
    pub fn plan(&mut self) -> Vec<DockStep> {
        let mut steps = Vec::new();
        if !self.made {
            return steps;
        }
        if let Some(at) = self.monitor {
            let rect = window_rect(&at, self.edge, self.dots, self.open);
            if self.placed != Some(rect) {
                steps.push(DockStep::Place(rect));
                self.placed = Some(rect);
            }
        }
        let visible = self.visible();
        if !visible && self.shown {
            steps.push(DockStep::Hide);
            self.shown = false;
        }
        if !visible && self.drawn && !self.asleep {
            steps.push(DockStep::Sleep);
            self.asleep = true;
        }
        if visible && !self.shown {
            if self.asleep {
                steps.push(DockStep::Wake);
                self.asleep = false;
            }
            steps.push(DockStep::Show);
            self.shown = true;
        }
        steps
    }

    /// Its page didn't draw in time. Some(true): make the window again, which this has started by
    /// forgetting it; Some(false): it was made again already, so it stays hidden, saying why.
    pub fn undrawn(&mut self) -> Option<bool> {
        if !self.made || self.drawn {
            return None;
        }
        if self.remade {
            self.why_not = Some("The dock's page didn't draw; nook.log says more");
            return Some(false);
        }
        *self = DockRun {
            setting: self.setting,
            remade: true,
            ..DockRun::default()
        };
        Some(true)
    }

    /// Whether its page should be sent events now: asleep, it gets the latest when it wakes.
    pub fn receives(&self) -> bool {
        !self.asleep
    }

    pub fn view(&self) -> DockView {
        DockView {
            on: self.setting,
            shown: self.shown,
            why_not: if self.setting {
                self.why_not.map(str::to_string)
            } else {
                None
            },
            open: self.open,
            edge: self.edge,
        }
    }
}

#[cfg(test)]
#[path = "dock_tests.rs"]
mod tests;
