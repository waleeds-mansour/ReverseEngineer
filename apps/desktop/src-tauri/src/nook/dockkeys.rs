// The keyboard for the agent dock's panels. The dock's window is never activated (surface.rs's
// own_style), so a click on it leaves the app you were in in front. A panel that wants the keyboard
// (notchPanel.ts's wantsKeys: the Inbox, the chat, the dock's menu) asks for it as it opens
// (UiCmd::DockKeys): Nook remembers the window in front, lets the dock's window be activated and
// brings it to the front (surface::keys), so the panel's keys reach the page. When the panel
// closes, while the dock still has the foreground, it goes back to the remembered window if
// focus.rs's decide allows it (the same process's, shown, not minimized, on this virtual desktop,
// not elevated or of unknown elevation, and not a game); otherwise to the first window under the
// dock that an app shows and decide's rules allow, or else to the desktop, so the dock's page never
// keeps the keys once its panel has gone. The dock's window is then made one that is never
// activated again. Clicking elsewhere lets the keyboard go without handing anything back, as the
// click already chose, and the page hears it in the chrome's dock.keys and closes the panel.
// Windows Hello's prompt taking the keyboard while it opens the desk, for the Inbox or the chat,
// lets nothing go, and the notch takes the keyboard back once the prompt is gone. While a panel has
// the keyboard, barwin.rs leaves the dock's activation alone instead of handing the foreground back
// as it does after a click on the bar.

use super::dock::DOCK_LABEL;
use super::host::{self, Shared};
use super::probe::{style, Elevation, Hwnd, Probe, WindowFacts};
use super::view::FrontWindow;
use super::window::{self, RealProbe};
use super::{dockinbox, focus, look, surface};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use windows::Win32::UI::WindowsAndMessaging::GetShellWindow;

/// Lets the dock's window take the keyboard or not, on the main thread; with `back`, handing the
/// foreground on first (hand_back), while the dock still has it.
fn on_main(app: &AppHandle, take: bool, back: Option<(Option<FrontWindow>, Vec<Hwnd>)>) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = a.get_webview_window(DOCK_LABEL) else {
            return;
        };
        if let Some((before, ours)) = back {
            hand_back(before.as_ref(), &ours);
        }
        surface::keys(&w, take);
    });
}

/// Gives the foreground away while one of Nook's windows (`ours`) has it: to `before` when
/// focus::decide allows, or else the first window down the z-order that suits, or else the
/// desktop's own window. A click elsewhere already chose, so then nothing is done.
fn hand_back(before: Option<&FrontWindow>, ours: &[Hwnd]) {
    let front = focus::foreground();
    if !front.is_some_and(|f| ours.contains(&f)) {
        return;
    }
    let to = focus::decide(front, ours, before, focus::live)
        .ok()
        .or_else(|| next_window(ours))
        .or_else(|| {
            let shell = unsafe { GetShellWindow() };
            (!shell.is_invalid()).then_some(shell.0 as Hwnd)
        });
    if let Some(h) = to {
        let _ = focus::hand_back(h);
    }
}

/// Whether a window may have the keyboard handed to it when the one before can't: an app's own
/// window (its Alt-Tab root), shown, not minimized, not a tool window or one never activated,
/// and on this virtual desktop (DWM hasn't cloaked it).
fn suits(f: &WindowFacts, cloaked: Option<u32>) -> bool {
    let ex = f.ex_style;
    f.root
        && f.alt_tab_root
        && f.visible
        && !f.iconic
        && ex & (style::WS_EX_TOOLWINDOW | style::WS_EX_NOACTIVATE) == 0
        && cloaked == Some(0)
}

/// The first window under Nook's, top to bottom, that suits and whose process isn't elevated or
/// of unknown elevation, as decide asks of the window before.
fn next_window(ours: &[Hwnd]) -> Option<Hwnd> {
    let p = RealProbe;
    p.top_level().into_iter().find(|&h| {
        !ours.contains(&h)
            && p.window(h)
                .is_some_and(|f| suits(&f, p.cloaked(h)) && unelevated(&p, f.pid))
    })
}

fn unelevated(p: &RealProbe, pid: u32) -> bool {
    p.process(pid).is_ok_and(|f| f.elevation == Elevation::No)
}

/// The window in front as decide reads it: nook-wm's view of it when it has one (`seen`), which
/// knows a game and the desktop it is on; else what Windows says of it now.
fn front(h: Hwnd, seen: Option<FrontWindow>) -> FrontWindow {
    if let Some(f) = seen.filter(|f| f.hwnd == h) {
        return f;
    }
    let pid = window::pid_of(h);
    let elevated = match RealProbe.process(pid).map(|f| f.elevation) {
        Ok(Elevation::No) => Some(false),
        Ok(Elevation::Yes) => Some(true),
        _ => None,
    };
    FrontWindow {
        hwnd: h,
        pid,
        elevated,
        // It had the foreground, so it was on this desktop; decide reads its cloak again.
        on_this_desktop: Some(true),
        ..FrontWindow::default()
    }
}

/// A panel that wants the keyboard opened: the notch takes it, remembering who had it.
pub fn take(shared: &Arc<Shared>) {
    let ours = shared.own_windows();
    let seen = shared.bar().before;
    let before = focus::foreground()
        .filter(|h| !ours.contains(h))
        .map(|h| front(h, seen));
    {
        let mut run = shared.dock();
        if !run.shown {
            return;
        }
        if !run.keys {
            run.before = before;
        }
        run.keys = true;
    }
    on_main(&shared.app, true, None);
}

/// The panel closed, or the notch lost the keyboard: it lets it go, and hands the foreground
/// on when `give_back`. An open Inbox closes with it.
pub fn release(shared: &Shared, give_back: bool) {
    let before = {
        let mut run = shared.dock();
        if !run.keys {
            return;
        }
        run.keys = false;
        run.before.take()
    };
    let back = give_back.then(|| (before, shared.own_windows()));
    on_main(&shared.app, false, back);
    dockinbox::let_go(shared);
    look::emit(shared);
}

/// Something else had the keyboard for a moment (Windows Hello's prompt): the notch takes it
/// back while a panel still wants it.
pub fn retake(shared: &Shared) {
    if shared.dock().keys {
        on_main(&shared.app, true, None);
    }
}

/// The same, for a panel that knows only the app (the chat's, hearth/chat.rs).
pub fn retake_app(app: &AppHandle) {
    if let Some(shared) = host::shared(app) {
        retake(&shared);
    }
}

/// Whether a panel has the keyboard in the window `label`, so its activation stays there
/// (barwin.rs's focused).
pub fn has_keys(app: &AppHandle, label: &str) -> bool {
    label == DOCK_LABEL && host::shared(app).is_some_and(|s| s.dock().keys)
}

/// Whether the window `label` losing the keyboard lets the panel's go: only the dock's, and not
/// while Windows Hello's prompt has it to open the desk (`unlocking`).
fn lets_go(label: &str, unlocking: bool) -> bool {
    label == DOCK_LABEL && !unlocking
}

/// A window of Hearth's lost the keyboard: the dock's, to a click elsewhere, lets it go without
/// handing anything back. Not while Windows Hello's prompt has it, for the Inbox or the chat.
pub fn blurred(app: &AppHandle, label: &str) {
    let unlocking = dockinbox::unlocking() || crate::hearth::chat::unlocking();
    if !lets_go(label, unlocking) {
        return;
    }
    if let Some(shared) = host::shared(app) {
        release(&shared, false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> WindowFacts {
        WindowFacts {
            root: true,
            alt_tab_root: true,
            visible: true,
            ..WindowFacts::default()
        }
    }

    #[test]
    fn windows_hello_unlocking_for_the_inbox_or_the_chat_keeps_the_keys() {
        assert!(lets_go(DOCK_LABEL, false), "a click elsewhere lets them go");
        assert!(
            !lets_go(DOCK_LABEL, true),
            "the prompt opening the desk doesn't"
        );
        assert!(!lets_go("main", false), "only the dock's window has them");
    }

    #[test]
    fn the_keys_go_on_only_to_an_apps_own_window_on_this_desktop() {
        assert!(suits(&app(), Some(0)));
        assert!(!suits(&app(), Some(2)), "cloaked: another virtual desktop");
        assert!(!suits(&app(), None), "a cloak Windows didn't say");
        let no = |f: fn(&mut WindowFacts)| {
            let mut w = app();
            f(&mut w);
            !suits(&w, Some(0))
        };
        assert!(no(|w| w.visible = false));
        assert!(no(|w| w.iconic = true));
        assert!(no(|w| w.alt_tab_root = false));
        assert!(no(|w| w.root = false));
        assert!(no(|w| w.ex_style = style::WS_EX_TOOLWINDOW));
        assert!(no(|w| w.ex_style = style::WS_EX_NOACTIVATE));
    }
}
