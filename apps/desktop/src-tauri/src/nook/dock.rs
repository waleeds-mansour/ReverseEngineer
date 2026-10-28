// What the agent dock should be doing, decided without touching a window so it can be tested
// anywhere; dockwin.rs carries the decisions out. The dock is a short strip of status dots on a
// side of the primary monitor, the right unless the owner chose the left, as far down it as they
// last dragged it (dockplace.rs), topmost and never activated: a dot for Pip, one for what waits
// for the owner's yes, and one for each of Hearth's services that needs the owner (agents.rs). It
// is made with its switch, which starts on, and shown once its page says it drew (the readiness
// handshake: a page that never says so is made again once). Over something fullscreen or a game
// it hides: Windows' own notification state says when, and while Nook observes for the bar or the
// panel, nook-wm's game guard and the window in front say it too, monitor by monitor. Its menu can
// hide it for an hour, after which it comes back on its own. Hovering it opens a card beside the
// strip, toward the middle of the screen, with the hovered dot's label, last line and a button;
// while the card is open the pointer is watched too, so a card the page never heard the pointer
// leave still closes. Its sizes are the page's CSS px, and WebView2 draws those at the monitor's
// DPI scale times Windows' text size, so the window is sized by both (drawn_at). The disabled
// file and safe start keep it off, as they keep the bar off. It needs no hook and no observer of
// its own.

use super::bar::{beside_rect, in_front, strip_rect, Place};
use super::chrome::{DockView, Edge};
use super::dockplace::{along_at, window_at, DockPlace};
use super::probe::{Hwnd, Rect};
use super::start::Status;
use super::view::{ModeName, NookState};
use std::time::Instant;

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
/// The hover card beside the strip, with room for its shadow: --card-w and --card-h in dock.css,
/// plus 12.
pub const CARD_SIZE: (i32, i32) = (248, 92);
/// What the view says while the dock's menu has hidden it.
pub const RESTING: &str = "Hidden from the dock's menu for an hour; it comes back on its own";
/// Windows' text size runs from 100 % to 225 % (Settings > Accessibility > Text size).
pub const TEXT_SIZES: (u32, u32) = (100, 225);

/// Windows' text size in percent, from the TextScaleFactor it keeps: 100 % when it has none.
pub fn text_size(raw: Option<u32>) -> u32 {
    raw.unwrap_or(TEXT_SIZES.0)
        .clamp(TEXT_SIZES.0, TEXT_SIZES.1)
}

/// The monitor as the dock's page is drawn on it. WebView2 draws a page at its rasterization
/// scale, the monitor's DPI scale times Windows' text size, so above 100 % every CSS px of the
/// page is bigger than the monitor's DPI alone says: a window sized by the DPI alone clips its
/// strip and card. Sizing by both keeps the window and its page the same size.
pub fn drawn_at(at: &Place, text: u32) -> Place {
    let text = text.clamp(TEXT_SIZES.0, TEXT_SIZES.1);
    Place {
        rect: at.rect,
        dpi: (at.dpi.max(1) * text + 50) / 100,
    }
}

/// Whether the pointer, in physical px, is over the dock's window where it was last placed.
pub fn holds(placed: Option<Rect>, cursor: Option<(i32, i32)>) -> bool {
    match (placed, cursor) {
        (Some(r), Some((x, y))) => x >= r.left && x < r.right && y >= r.top && y < r.bottom,
        _ => false,
    }
}

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
    /// Which side it sits on, and how far down each side.
    pub place: DockPlace,
    /// Hidden from its menu until then.
    pub resting: Option<Instant>,
    /// Being dragged along its edge: the strip's top and the pointer's height when it began.
    pub drag: Option<(i32, i32)>,
    /// How many dots the page shows.
    pub dots: usize,
    /// The pointer is over the dock, so its card has room.
    pub open: bool,
    /// Windows' text size in percent, as last read; below 100 reads as 100 (drawn_at).
    pub text: u32,
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
        self.made
            && self.drawn
            && self.monitor.is_some()
            && self.resting.is_none()
            && !self.in_the_way()
    }

    /// What decides where the window goes and whether it shows, to tell when that changed.
    pub fn seen(&self) -> (bool, Option<Place>, usize, bool, u32, DockPlace) {
        (
            self.visible(),
            self.monitor,
            self.dots,
            self.open,
            self.text,
            self.place,
        )
    }

    /// A run with no window yet, keeping what the owner chose: the switch, the place and a rest.
    pub fn kept(&self) -> DockRun {
        DockRun {
            setting: self.setting,
            place: self.place,
            resting: self.resting,
            ..DockRun::default()
        }
    }

    /// The owner's switch. Turning it either way ends a rest, so the switch is what counts.
    pub fn switch(&mut self, on: bool) {
        self.setting = on;
        self.resting = None;
    }

    /// Moves it to `edge`, at that side's own spot. The place to keep.
    pub fn move_to(&mut self, edge: Edge) -> DockPlace {
        self.place = self.place.on(edge);
        self.open = false;
        self.place
    }

    /// Hidden from its menu until `until`.
    pub fn rest(&mut self, until: Instant) {
        self.resting = Some(until);
        self.open = false;
    }

    /// Whether a rest is over by `now`, which ends it.
    pub fn wake(&mut self, now: Instant) -> bool {
        let over = self.resting.is_some_and(|until| now >= until);
        if over {
            self.resting = None;
        }
        over
    }

    /// The strip was pressed and moved with the pointer at height `y`: from now it follows the
    /// pointer along its edge, with its card closed. Whether it can (it shows, where it was put).
    pub fn drag_start(&mut self, y: i32) -> bool {
        let Some(r) = self.placed.filter(|_| self.visible()) else {
            return false;
        };
        self.drag = Some((r.top, y));
        self.open = false;
        true
    }

    /// The pointer is at height `y` while dragging: the strip moves with it, kept on the monitor.
    /// Whether it moved.
    pub fn drag_to(&mut self, y: i32) -> bool {
        let (Some((top, from)), Some(at)) = (self.drag, self.monitor) else {
            return false;
        };
        let at = drawn_at(&at, self.text);
        let along = along_at(&at, self.place.edge, self.dots, top + y - from);
        let was = self.place;
        self.place = self.place.moved(along);
        self.place != was
    }

    /// The button came up: the place to keep, if it was being dragged.
    pub fn drag_end(&mut self) -> Option<DockPlace> {
        self.drag.take().map(|_| self.place)
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

    /// The pointer came over the dock, or left it. No card while the strip is dragged.
    pub fn hover(&mut self, open: bool) {
        self.open = open && self.visible() && self.drag.is_none();
    }

    /// Where the pointer is, read while the card is open. One that has left the window closes
    /// the card, whatever its page heard: a pointer that leaves fast, or a window that shrinks or
    /// hides under it, can leave the page none the wiser. Whether that closed it.
    pub fn pointer(&mut self, cursor: Option<(i32, i32)>) -> bool {
        if !self.open || holds(self.placed, cursor) {
            return false;
        }
        self.open = false;
        true
    }

    /// The steps that bring the window to what it should be, recorded as done.
    pub fn plan(&mut self) -> Vec<DockStep> {
        let mut steps = Vec::new();
        if !self.made {
            return steps;
        }
        if let Some(at) = self.monitor {
            let at = drawn_at(&at, self.text);
            let (edge, along) = (self.place.edge, self.place.along());
            let rect = window_at(&at, edge, self.dots, self.open, along);
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
            remade: true,
            ..self.kept()
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
            why_not: match (self.setting, self.resting) {
                (false, _) => None,
                (true, Some(_)) => Some(RESTING.into()),
                (true, None) => self.why_not.map(str::to_string),
            },
            open: self.open,
            edge: self.place.edge,
        }
    }
}

#[cfg(test)]
#[path = "dock_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "dockplace_run_tests.rs"]
mod place_tests;
