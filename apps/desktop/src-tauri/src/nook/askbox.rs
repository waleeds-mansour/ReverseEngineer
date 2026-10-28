// What Nook lends the quick-ask box (hearth/quick_ask.rs), a page of this app's own like Nook's:
// the check that a page is bundled with the app, the theme Nook's pages draw with, the DPI
// WebView2 draws a page at with Windows' text size, the page of Hearth's window a dock card's
// Open conversation opens, an app's name from its exe, the dock's check for a game in front and
// nook-wm's game guard for the window in front, and a place among Nook's own windows. Away from Windows, Nook has none of these to lend, and the
// box doesn't open.

use super::chrome::ChromeView;
use super::view::DockPage;
use tauri::{AppHandle, Url};

/// A page bundled with this app, or Vite's dev server while developing.
#[cfg(windows)]
pub fn is_local(app: &AppHandle, url: &Url) -> bool {
    super::ui::is_local(app, url)
}

/// The theme, glass and motion Nook's pages draw with now.
#[cfg(windows)]
pub fn chrome(app: &AppHandle) -> Option<ChromeView> {
    super::host::shared(app).map(|s| super::look::fresh(&s))
}

/// The DPI a page is drawn at on a monitor of `dpi`: its DPI scale times Windows' text size, as
/// the dock's and the bar's windows are sized (dock.rs, drawn_at).
#[cfg(windows)]
pub fn drawn_dpi(dpi: u32) -> u32 {
    let at = super::bar::Place {
        rect: Default::default(),
        dpi,
    };
    super::dock::drawn_at(&at, super::dockwin::text_now()).dpi
}

/// Opens the page of Hearth's window that a button on the dock's card opens (dockact.rs).
#[cfg(windows)]
pub fn open_page(app: &AppHandle, page: DockPage) {
    crate::hearth::window::open(app, super::dockact::path(page));
}

/// An app's name from its exe, like "Google Chrome".
#[cfg(windows)]
pub fn app_name(path: &str) -> Option<String> {
    super::process::description(path)
}

/// That page as a link a notification opens.
#[cfg(windows)]
pub fn page_link(page: DockPage) -> Option<String> {
    Some(format!("hearth://open{}", super::dockact::path(page)))
}

/// Whether a game or something fullscreen is in front, as the dock judges it: Windows'
/// notification state, and nook-wm's game guard while it observes. Nothing opens a process.
#[cfg(windows)]
pub fn game_in_front(app: &AppHandle) -> bool {
    if super::game::notification_state().is_some_and(super::dock::busy) {
        return true;
    }
    super::host::shared(app).is_some_and(|s| {
        let state = s.snapshot.lock().unwrap_or_else(|p| p.into_inner());
        state.mode == super::view::ModeName::Observing
            && super::bar::in_front(&state, &[]).game_anywhere
    })
}

/// Whether the window in front, `hwnd` of the program at `path`, is a game by nook-wm's game
/// guard (game.rs): an engine's or a launcher's class, a game folder, or borderless and filling
/// its monitor. Judged here from user32 reads, so it holds while Nook arranges nothing.
#[cfg(windows)]
pub fn game_window(hwnd: isize, path: Option<&str>) -> bool {
    let Some(f) = super::window::RealProbe::facts(hwnd) else {
        return false;
    };
    let monitors = super::monitors::enumerate();
    let front = super::game::Front {
        class: &f.class,
        style: f.style,
        rect: f.rect,
        monitor: super::monitors::holding(&monitors, &f.rect).map(|m| m.rect),
        path,
    };
    super::game::judge(None, Some(&front)).is_some()
}

/// The box's window was made: nook-wm and the bar now count it as one of Nook's own.
#[cfg(windows)]
pub fn made(app: &AppHandle) {
    if let Some(s) = super::host::shared(app) {
        super::barwin::tell_own(&s);
    }
}

#[cfg(not(windows))]
pub fn is_local(_app: &AppHandle, _url: &Url) -> bool {
    false
}

#[cfg(not(windows))]
pub fn chrome(_app: &AppHandle) -> Option<ChromeView> {
    None
}

#[cfg(not(windows))]
pub fn drawn_dpi(dpi: u32) -> u32 {
    dpi
}

#[cfg(not(windows))]
pub fn open_page(_app: &AppHandle, _page: DockPage) {}

#[cfg(not(windows))]
pub fn app_name(_path: &str) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn page_link(_page: DockPage) -> Option<String> {
    None
}

#[cfg(not(windows))]
pub fn game_in_front(_app: &AppHandle) -> bool {
    false
}

#[cfg(not(windows))]
pub fn game_window(_hwnd: isize, _path: Option<&str>) -> bool {
    false
}

#[cfg(not(windows))]
pub fn made(_app: &AppHandle) {}
