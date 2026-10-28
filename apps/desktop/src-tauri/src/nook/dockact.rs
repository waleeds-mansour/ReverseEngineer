// What the owner does to the agent dock itself, as dock.rs decides it: its menu (dockmenu.rs),
// dragging the edge tab along its edge, moving it to the other side, hiding it for an hour, its
// sounds, the buttons on its open pill and status label, which open a page of Hearth's own window,
// and the pill's mic, which starts talking to Pip just as talk mode's hotkey does. None of it acts
// on Hearth: a button only opens a page, where the owner's own session does whatever is done
// there, and the mic only starts listening. Where the dock sits, and whether it sounds, are kept
// as soon as they change (dockplace.rs, settings.rs).

use super::chrome::Edge;
use super::dock::DOCK_LABEL;
use super::dockmenu::{self, Choice};
use super::dockplace::{self, DockPlace};
use super::dockwin::{self, nudge};
use super::host::{self, Shared};
use super::view::DockPage;
use super::{look, settings, ui};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON};

/// How long its menu hides the dock.
pub const REST_FOR: Duration = Duration::from_secs(60 * 60);
/// How often the pointer is read while the tab is dragged.
const DRAG_EVERY: Duration = Duration::from_millis(16);
/// A drag that outlasts this ends, in case the button's release was never seen.
const DRAG_LONGEST: Duration = Duration::from_secs(60);

/// The page of Hearth a button on the dock's open pill or label opens. Pip's conversation is its pane, which
/// `?jarvis` opens on the last conversation, with its Stop; what waits for a yes is on Today; and
/// the services' health is a section of Settings.
pub fn path(page: DockPage) -> &'static str {
    match page {
        DockPage::Conversation => "/today?jarvis",
        DockPage::Approvals => "/today",
        DockPage::Status => "/settings?section=health",
    }
}

pub fn open(shared: &Shared, page: DockPage) {
    crate::hearth::window::open(&shared.app, path(page));
}

/// The pill's mic: talk mode starts, or stops if it is listening already, by the same toggle a
/// remote trigger of talk mode's hotkey gives the transcription coordinator, so it records, sends
/// what was said to Pip and reads the answer aloud exactly as the hotkey does.
pub fn talk(app: &AppHandle) {
    crate::signal_handle::send_transcription_input(app, crate::hearth::TALK_BINDING, "Nook's dock");
}

/// A right click on the tab or the pill, or the pill's "…": the menu, at the pointer, on the main
/// thread. What the owner chooses is carried out off it.
pub fn menu(shared: &Arc<Shared>) {
    let (edge, shown, sounds) = {
        let run = shared.dock();
        (run.place.edge, run.shown, run.sounds)
    };
    let Some(at) = dockwin::cursor().filter(|_| shown) else {
        return;
    };
    let app = shared.app.clone();
    let _ = shared.app.run_on_main_thread(move || {
        let Some(w) = app.get_webview_window(DOCK_LABEL) else {
            return;
        };
        if let Some(choice) = dockmenu::show(&w, edge, sounds, at) {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || chose(&app, choice));
        }
    });
}

fn chose(app: &AppHandle, choice: Choice) {
    let Some(shared) = host::shared(app) else {
        return;
    };
    let done = match choice {
        Choice::Edge(edge) => to_edge(&shared, edge),
        Choice::Rest => {
            shared.dock().rest(Instant::now() + REST_FOR);
            log::info!("Nook's agent dock is hidden for an hour from its menu");
            Ok(())
        }
        Choice::Sounds(on) => sounds(&shared, on),
        Choice::Settings => {
            ui::open_panel(app);
            Ok(())
        }
        Choice::Off => switch(&shared, false),
    };
    if let Err(e) = done {
        log::warn!("The dock's menu couldn't do that: {e}");
    }
    nudge(app);
    look::emit(&shared);
}

/// The owner's switch, from Nook's panel or the dock's menu.
pub fn switch(shared: &Arc<Shared>, on: bool) -> Result<(), String> {
    settings::save_dock(&shared.app, on)?;
    shared.dock().switch(on);
    dockwin::sync(shared);
    Ok(())
}

/// The dock's sounds, from its menu. The page hears it in the chrome's dock.sounds.
pub fn sounds(shared: &Shared, on: bool) -> Result<(), String> {
    settings::save_dock_sounds(&shared.app, on)?;
    shared.dock().sounds = on;
    Ok(())
}

/// Over to `edge`, from Nook's panel or the dock's menu.
pub fn to_edge(shared: &Shared, edge: Edge) -> Result<(), String> {
    if edge == Edge::Top {
        return Err("the dock sits on the left or the right edge".into());
    }
    let place = shared.dock().move_to(edge);
    nudge(&shared.app);
    keep(&shared.app, place)
}

fn keep(app: &AppHandle, place: DockPlace) -> Result<(), String> {
    dockplace::save(app, place).inspect_err(|e| log::warn!("Couldn't keep where the dock is: {e}"))
}

/// The page saw the tab or the pill pressed and moved past a click: from here the tab follows the
/// pointer along its edge until the button comes up, read from Windows rather than from the page,
/// which moves under the pointer.
pub fn drag(shared: &Arc<Shared>) {
    let Some((_, y)) = dockwin::cursor() else {
        return;
    };
    if !shared.dock().drag_start(y) {
        return;
    }
    nudge(&shared.app);
    look::emit(shared);
    let s = shared.clone();
    let began = Instant::now();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DRAG_EVERY).await;
            let held = button_held() && began.elapsed() < DRAG_LONGEST;
            let at = dockwin::cursor();
            let (moved, ended) = {
                let mut run = s.dock();
                let moved = held && at.is_some_and(|(_, y)| run.drag_to(y));
                (moved, if held { None } else { Some(run.drag_end()) })
            };
            if moved {
                nudge(&s.app);
            }
            if let Some(place) = ended {
                if let Some(place) = place {
                    let _ = keep(&s.app, place);
                }
                look::emit(&s);
                return;
            }
        }
    });
}

/// Whether the primary mouse button is down, whichever button the owner made primary.
fn button_held() -> bool {
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    let button = if swapped { VK_RBUTTON } else { VK_LBUTTON };
    // The high bit, read as a negative number, says the button is down now.
    let state = unsafe { GetAsyncKeyState(i32::from(button.0)) };
    state < 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_docks_buttons_open_hearth_pages_and_nothing_else() {
        assert_eq!(path(DockPage::Conversation), "/today?jarvis");
        assert_eq!(path(DockPage::Approvals), "/today");
        assert_eq!(path(DockPage::Status), "/settings?section=health");
        let home: tauri::Url = "http://localhost:4400".parse().unwrap();
        for page in [
            DockPage::Conversation,
            DockPage::Approvals,
            DockPage::Status,
        ] {
            let url = crate::hearth::links::page_url(&home, path(page)).unwrap();
            assert_eq!(url.origin(), home.origin(), "{page:?}");
            assert!(!url.path().starts_with("/api"), "{page:?}");
        }
        assert_eq!(REST_FOR, Duration::from_secs(3600));
    }
}
