// Handing the foreground back (docs/nook-wm.md, "BAR BUILDER"; P1's exit criteria allow it as the
// fallback): the bar and its popover are never activated, but WebView2 hosts its input in a child
// window, so a click may still bring them to the front. Only when the foreground really is the bar
// or the popover does Nook give it back, and only to the window nook-wm saw in front just before,
// if that window still exists as the same process's, is visible and not minimized, is on this
// virtual desktop, isn't elevated or of unknown elevation, and isn't a game by the guard's verdict. It changes nothing else about that
// window and doesn't go through the seam, whose counters are for arranging: diag.json counts these
// apart, as focus_restores.

use super::probe::{Hwnd, Probe};
use super::view::FrontWindow;
use super::window::{self, RealProbe};
use serde::Serialize;
use std::collections::BTreeMap;
use windows::Win32::UI::WindowsAndMessaging::{
    IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow,
};

/// Why the foreground stayed where it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refused {
    /// The foreground isn't the bar or the popover, as when the popover is shown: nothing to give.
    NotOurs,
    /// nook-wm saw no window in front before them.
    NothingBefore,
    /// Closed, or its handle now belongs to another process's window.
    Gone,
    Hidden,
    Minimized,
    OtherDesktop,
    Elevated,
    ElevationUnknown,
    Game,
}

impl Refused {
    pub fn code(self) -> &'static str {
        match self {
            Refused::NotOurs => "not_ours",
            Refused::NothingBefore => "nothing_before",
            Refused::Gone => "gone",
            Refused::Hidden => "hidden",
            Refused::Minimized => "minimized",
            Refused::OtherDesktop => "other_desktop",
            Refused::Elevated => "elevated",
            Refused::ElevationUnknown => "elevation_unknown",
            Refused::Game => "game",
        }
    }
}

/// What Windows says about that window now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Live {
    pub exists: bool,
    /// The window's process, 0 when Windows didn't say.
    pub pid: u32,
    pub visible: bool,
    pub iconic: bool,
    /// DWM's cloak, which Windows sets on windows of other virtual desktops; None if unread.
    pub cloaked: Option<u32>,
}

/// The window to give the foreground back to, or why none. `ours` are the bar's and popover's
/// windows; `live` reads the window now, and only once everything known allows it.
pub fn decide(
    foreground: Option<Hwnd>,
    ours: &[Hwnd],
    before: Option<&FrontWindow>,
    live: impl FnOnce(Hwnd) -> Live,
) -> Result<Hwnd, Refused> {
    if !foreground.is_some_and(|f| ours.contains(&f)) {
        return Err(Refused::NotOurs);
    }
    let b = before
        .filter(|b| !ours.contains(&b.hwnd))
        .ok_or(Refused::NothingBefore)?;
    if b.game {
        return Err(Refused::Game);
    }
    match b.elevated {
        Some(false) => {}
        Some(true) => return Err(Refused::Elevated),
        None => return Err(Refused::ElevationUnknown),
    }
    if b.on_this_desktop == Some(false) {
        return Err(Refused::OtherDesktop);
    }
    let now = live(b.hwnd);
    if !now.exists || now.pid != b.pid {
        return Err(Refused::Gone);
    }
    if !now.visible {
        return Err(Refused::Hidden);
    }
    if now.iconic {
        return Err(Refused::Minimized);
    }
    if now.cloaked != Some(0) {
        return Err(Refused::OtherDesktop);
    }
    Ok(b.hwnd)
}

/// diag.json's count of hand-backs, kept apart from the seam's writes.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Tally {
    pub focus_restores: u64,
    /// Windows refused the hand-back.
    pub focus_failed: u64,
    pub focus_refused: BTreeMap<&'static str, u64>,
}

impl Tally {
    /// Counts one outcome, and says what nook.log should read the first time it happens.
    pub fn count(&mut self, decided: Result<Hwnd, Refused>, landed: bool) -> Option<String> {
        let (n, text) = match decided {
            Ok(_) if landed => (&mut self.focus_restores, "handed back".to_string()),
            Ok(_) => (
                &mut self.focus_failed,
                "Windows refused to hand it back".into(),
            ),
            Err(r) => (
                self.focus_refused.entry(r.code()).or_default(),
                format!("left: {}", r.code()),
            ),
        };
        *n += 1;
        (*n == 1).then_some(text)
    }
}

/// The window now in front.
pub fn foreground() -> Option<Hwnd> {
    window::foreground()
}

pub fn live(h: Hwnd) -> Live {
    let w = window::hwnd(h);
    Live {
        exists: unsafe { IsWindow(Some(w)) }.as_bool(),
        pid: window::pid_of(h),
        visible: unsafe { IsWindowVisible(w) }.as_bool(),
        iconic: unsafe { IsIconic(w) }.as_bool(),
        cloaked: RealProbe.cloaked(h),
    }
}

/// Whether the window has the foreground again.
pub fn hand_back(h: Hwnd) -> bool {
    unsafe { SetForegroundWindow(window::hwnd(h)) }.as_bool()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BAR: Hwnd = 0xB0;
    const POPOVER: Hwnd = 0xB1;
    const OURS: &[Hwnd] = &[BAR, POPOVER];
    const APP: Hwnd = 0x100;
    const PID: u32 = 4242;

    fn app() -> FrontWindow {
        FrontWindow {
            hwnd: APP,
            pid: PID,
            elevated: Some(false),
            on_this_desktop: Some(true),
            ..FrontWindow::default()
        }
    }

    fn fine(_: Hwnd) -> Live {
        Live {
            exists: true,
            pid: PID,
            visible: true,
            iconic: false,
            cloaked: Some(0),
        }
    }

    fn with(f: impl Fn(&mut FrontWindow)) -> Result<Hwnd, Refused> {
        let mut b = app();
        f(&mut b);
        decide(Some(BAR), OURS, Some(&b), fine)
    }

    fn now(l: Live) -> Result<Hwnd, Refused> {
        decide(Some(POPOVER), OURS, Some(&app()), |_| l)
    }

    #[test]
    fn a_click_that_activated_the_bar_hands_the_app_back_its_foreground() {
        assert_eq!(decide(Some(BAR), OURS, Some(&app()), fine), Ok(APP));
        assert_eq!(decide(Some(POPOVER), OURS, Some(&app()), fine), Ok(APP));
    }

    #[test]
    fn opening_the_popover_from_a_bar_click_hands_nothing_back() {
        // The click didn't activate the bar: the app is still in front when the popover shows.
        let mut read = false;
        let r = decide(Some(APP), OURS, Some(&app()), |_| {
            read = true;
            fine(APP)
        });
        assert_eq!(r, Err(Refused::NotOurs));
        assert!(!read, "nothing about the app is read");
        assert_eq!(
            decide(None, OURS, Some(&app()), fine),
            Err(Refused::NotOurs)
        );
    }

    #[test]
    fn with_no_window_before_the_bar_nothing_is_handed_back() {
        assert_eq!(
            decide(Some(BAR), OURS, None, fine),
            Err(Refused::NothingBefore)
        );
        let popover = FrontWindow {
            hwnd: POPOVER,
            ..app()
        };
        assert_eq!(
            decide(Some(BAR), OURS, Some(&popover), fine),
            Err(Refused::NothingBefore)
        );
    }

    #[test]
    fn a_window_that_is_gone_is_left() {
        let gone = Live {
            exists: false,
            ..fine(APP)
        };
        assert_eq!(now(gone), Err(Refused::Gone));
        // The app closed and Windows gave its handle to another process's window.
        let reused = Live {
            pid: PID + 1,
            ..fine(APP)
        };
        assert_eq!(now(reused), Err(Refused::Gone));
    }

    #[test]
    fn a_minimized_window_is_left() {
        let minimized = Live {
            iconic: true,
            ..fine(APP)
        };
        assert_eq!(now(minimized), Err(Refused::Minimized));
        assert_eq!(Refused::Minimized.code(), "minimized");
    }

    #[test]
    fn a_hidden_window_is_left() {
        let hidden = Live {
            visible: false,
            ..fine(APP)
        };
        assert_eq!(now(hidden), Err(Refused::Hidden));
    }

    #[test]
    fn a_window_on_another_virtual_desktop_is_left() {
        assert_eq!(
            with(|b| b.on_this_desktop = Some(false)),
            Err(Refused::OtherDesktop)
        );
        let cloaked = Live {
            cloaked: Some(2),
            ..fine(APP)
        };
        assert_eq!(now(cloaked), Err(Refused::OtherDesktop));
        let unread = Live {
            cloaked: None,
            ..fine(APP)
        };
        assert_eq!(now(unread), Err(Refused::OtherDesktop));
        // nook-com not having answered yet is fine while DWM says it isn't cloaked.
        assert_eq!(with(|b| b.on_this_desktop = None), Ok(APP));
    }

    #[test]
    fn an_elevated_window_is_left() {
        assert_eq!(with(|b| b.elevated = Some(true)), Err(Refused::Elevated));
    }

    #[test]
    fn a_window_of_unknown_elevation_is_left() {
        assert_eq!(with(|b| b.elevated = None), Err(Refused::ElevationUnknown));
    }

    #[test]
    fn a_game_by_the_guards_verdict_is_left() {
        assert_eq!(with(|b| b.game = true), Err(Refused::Game));
    }

    #[test]
    fn each_outcome_is_counted_and_logged_once() {
        let mut t = Tally::default();
        assert_eq!(t.count(Ok(APP), true).as_deref(), Some("handed back"));
        assert_eq!(t.count(Ok(APP), true), None);
        assert!(t.count(Ok(APP), false).is_some());
        assert_eq!(
            t.count(Err(Refused::Elevated), false).as_deref(),
            Some("left: elevated")
        );
        assert_eq!(t.count(Err(Refused::Elevated), false), None);
        assert_eq!((t.focus_restores, t.focus_failed), (2, 1));
        assert_eq!(t.focus_refused.get("elevated"), Some(&2));
        let json = serde_json::to_value(&t).unwrap();
        assert_eq!(json["focus_restores"], 2);
    }
}
