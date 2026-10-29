// What the agent dock should be doing, decided without touching a window so it can be tested
// anywhere; dockwin.rs carries the decisions out. The dock is the notch: one black shape on a side
// of the primary monitor, the right unless the owner chose the left, that everything opens inside
// (docksize.rs). At rest it is the edge tab, as far down the side as the owner last dragged it
// (dockplace.rs), topmost and never activated, with a dot for Pip, one for what waits for the
// owner's yes and one for each of Hearth's services that needs the owner (agents.rs), and a count
// badge for what waits. Its page grows the same shape into a column of icons when hovered, and
// round a panel when one opens (notchPanel.ts), and says so (shape): whether it is open, whether a
// panel holds it open, and the outlines it draws, which the window's region follows (dockclip.rs).
// While it is open and nothing holds it, the pointer is watched too, so a notch whose page never
// heard the pointer leave still folds; a panel that wants the keyboard gets it (dockkeys.rs).
// It is made with its switch, which starts on, and shown once its page says it drew (the readiness
// handshake: a page that never says so is made again once). Over something fullscreen or a game
// it hides: Windows' own notification state says when, and while Nook observes for the bar or the
// panel, nook-wm's game guard and the window in front say it too, monitor by monitor. Its menu
// can hide it for an hour, after which it comes back on its own. WebView2 draws the page's CSS px
// at the monitor's DPI scale times Windows' text size, zoomed by the owner's size for the dock
// (less where the window wouldn't fit the work area), so the window is sized by all three
// (drawn_at). It is made once at its biggest, as tall as the work area, so the notch never opens
// under the taskbar, and only moves or resizes when the monitor, the side or the size changes. The
// disabled file and safe start keep it off, as they keep the bar off.

use super::bar::{in_front, Place};
use super::chrome::DockView;
use super::dockclip::Shape;
use super::dockplace::{usable, DockPlace};
use super::docksize::{fitting, scale, window_rect, SCALE};
use super::probe::{Hwnd, Rect};
use super::start::Status;
use super::view::{FrontWindow, ModeName, NookState};
use std::time::Instant;

pub const DOCK_LABEL: &str = "nook_dock";
pub const DOCK_PAGE: &str = "src/nook/dock.html";
/// What the view says while the dock's menu has hidden it.
pub const RESTING: &str = "Hidden from the dock's menu for an hour; it comes back on its own";
/// Windows' text size runs from 100 % to 225 % (Settings > Accessibility > Text size).
pub const TEXT_SIZES: (u32, u32) = (100, 225);

/// Whether the agent dock is on the screen now: made, drawn and shown, and not hidden for a game,
/// something fullscreen, a busy state or an hour's rest. Hearth's notifications go to it then.
pub fn showing(app: &tauri::AppHandle) -> bool {
    super::host::shared(app).is_some_and(|s| {
        let run = s.dock();
        run.shown && run.visible()
    })
}

/// Windows' text size in percent, from the TextScaleFactor it keeps: 100 % when it has none.
pub fn text_size(raw: Option<u32>) -> u32 {
    raw.unwrap_or(TEXT_SIZES.0)
        .clamp(TEXT_SIZES.0, TEXT_SIZES.1)
}

/// The monitor as a page of Nook's (the bar's, say) is drawn on it at Windows' text size.
pub fn drawn_at(at: &Place, text: u32) -> Place {
    dock_at(at, text, 100)
}

/// The monitor as the dock's page is drawn on it. WebView2 draws a page at the monitor's DPI scale
/// times Windows' text size, and the dock zooms its page by the owner's size for it (`size`, in
/// percent), so every CSS px is bigger than the DPI alone says: a window sized by the DPI alone
/// clips the notch. Sizing by all three keeps the window and its page the same size.
pub fn dock_at(at: &Place, text: u32, size: u32) -> Place {
    let text = u64::from(text.clamp(TEXT_SIZES.0, TEXT_SIZES.1));
    let dpi = u64::from(at.dpi.max(1)) * text * u64::from(size.max(1));
    Place {
        rect: at.rect,
        dpi: ((dpi + 5000) / 10000) as u32,
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

/// One thing to do to the dock's window, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DockStep {
    /// Its page is zoomed to the owner's size for the dock, in percent.
    Zoom(u32),
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
    /// Being dragged along its edge: the tab's middle and the pointer's height when it began, and
    /// where its middle was a move ago, so the region keeps both until the page has drawn it.
    pub drag: Option<(i32, i32)>,
    pub trail: Option<i32>,
    /// How many dots the page shows, and whether its count badge shows (anything waits).
    pub dots: usize,
    pub waiting: bool,
    /// The page says the notch is open, unfolded from the tab under the pointer, and whether a
    /// panel holds it open wherever the pointer goes.
    pub open: bool,
    pub hold: bool,
    /// The outlines the page draws, in CSS px from the window's top-left (dockclip.rs).
    pub outlines: Vec<Vec<(f64, f64)>>,
    /// A panel has the keyboard, and the window that had it before (dockkeys.rs).
    pub keys: bool,
    pub before: Option<FrontWindow>,
    /// The owner's switches for its sounds and its size in percent, as last read or saved.
    pub sounds: bool,
    pub scale: u32,
    /// Windows' text size in percent, as last read; below 100 reads as 100 (drawn_at).
    pub text: u32,
    /// The primary monitor: nook-wm's while it observes, otherwise as the dock read it; and its
    /// work area, without the taskbar.
    pub monitor: Option<Place>,
    pub work: Option<Rect>,
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
    pub zoomed: Option<u32>,
    pub clipped: Option<Vec<Shape>>,
    /// The window was made a second time because its page didn't draw the first.
    pub remade: bool,
}

impl DockRun {
    pub fn new(setting: bool) -> DockRun {
        DockRun {
            setting,
            sounds: true,
            scale: SCALE,
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
    pub fn seen(&self) -> (bool, Option<Place>, usize, bool, u32, DockPlace, u32) {
        let (v, m) = (self.visible(), self.monitor);
        (
            v, m, self.dots, self.open, self.text, self.place, self.scale,
        )
    }

    /// A run with no window yet, keeping what the owner chose (the switches, the place, the size
    /// and a rest) and the dots it shows, so a window made again shows them at once.
    pub fn kept(&self) -> DockRun {
        DockRun {
            setting: self.setting,
            sounds: self.sounds,
            scale: self.scale,
            place: self.place,
            resting: self.resting,
            dots: self.dots,
            waiting: self.waiting,
            ..DockRun::default()
        }
    }

    /// The monitor as the page is drawn on it, kept to its work area (dockplace.rs's usable),
    /// and the zoom it is drawn at: the owner's size, or as much as fits (docksize.rs's fitting).
    fn fitted(&self) -> Option<(Place, u32)> {
        let at = usable(&self.monitor?, self.work);
        let zoom = fitting(self.scale, &at, self.text);
        Some((dock_at(&at, self.text, zoom), zoom))
    }

    pub fn at(&self) -> Option<Place> {
        self.fitted().map(|(at, _)| at)
    }

    /// The tab's middle in the page's CSS px down its window, as the page is told it.
    pub fn mid(&self) -> Option<i32> {
        let (px, at) = (self.mid_px()?, self.at()?);
        Some((f64::from(px) * 96.0 / f64::from(at.dpi.max(1))).round() as i32)
    }

    /// The owner's switch. Turning it either way ends a rest, so the switch is what counts.
    pub fn switch(&mut self, on: bool) {
        self.setting = on;
        self.resting = None;
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
            let primary = state.monitors.iter().find(|m| m.primary);
            self.work = primary.map(|m| Rect {
                left: m.work.x,
                top: m.work.y,
                right: m.work.x + m.work.width,
                bottom: m.work.y + m.work.height,
            });
        }
        self.game_here = seen.game_here;
        self.covered = seen.covered;
        self.folds();
    }

    /// The dock's own reading of Windows, every few seconds: the primary monitor and its work
    /// area, which count only while nook-wm isn't observing.
    pub fn read(&mut self, busy: bool, monitor: Option<(Place, Rect)>) {
        self.busy = busy;
        if let Some((at, work)) = monitor.filter(|_| !self.observing) {
            self.monitor = Some(at);
            self.work = Some(work);
        }
        self.folds();
    }

    /// A dock that doesn't show is neither open nor held open.
    fn folds(&mut self) {
        self.open = self.open && self.visible();
        self.hold = self.hold && self.visible();
    }

    /// What the page says of the notch: open or not, held open by a panel or not, and the outlines
    /// it draws. Not open while the tab is dragged or the dock doesn't show. Whether that opened
    /// it, so the pointer is watched.
    pub fn shape(&mut self, open: bool, hold: bool, outlines: Vec<Vec<(f64, f64)>>) -> bool {
        let was = self.open;
        self.open = open && self.visible() && self.drag.is_none();
        self.hold = hold && self.visible();
        self.outlines = outlines;
        self.open && !was
    }

    /// Where the pointer is, read while the notch is open and nothing holds it. Leaving
    /// what the window's region covers folds it, whatever its page heard: a pointer that leaves
    /// fast, or a dock that hides under it, can leave the page none the wiser. Whether it folded.
    pub fn pointer(&mut self, cursor: Option<(i32, i32)>) -> bool {
        if !self.open || self.hold || self.covers(cursor) {
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
        if let Some((at, zoom)) = self.fitted() {
            if self.zoomed != Some(zoom) {
                steps.push(DockStep::Zoom(zoom));
                self.zoomed = Some(zoom);
            }
            let rect = window_rect(&at, self.place.edge);
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
            sounds: self.sounds,
            // look.rs knows where the dots come from.
            feed: false,
            mid: self.mid().unwrap_or(0),
            scale: scale(self.scale),
            keys: self.keys,
        }
    }
}

#[cfg(test)]
#[path = "dock_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "dockplace_run_tests.rs"]
mod place_tests;
