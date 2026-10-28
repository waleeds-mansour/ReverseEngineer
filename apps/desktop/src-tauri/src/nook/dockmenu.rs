// The agent dock's menu, on a right click on its strip: Windows' own small menu at the pointer,
// with moving the dock to the other side, hiding it for an hour, Nook's panel where its settings
// are, and turning it off. A menu closes on Esc or a click elsewhere only while its window is in
// front, so the dock takes the foreground for as long as the menu is up, as any right-click menu
// does, and gives it back to the window that had it once the menu closes without one being
// clicked. While the menu is up, the bar's own hand-back after a click on Nook's windows
// (barwin::focused) waits, or it would close the menu as it opens. Only the choice is decided
// here: dockact.rs carries it out.

use super::chrome::Edge;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Runtime, WebviewWindow};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreatePopupMenu, DestroyMenu, GetForegroundWindow, IsWindow, PostMessageW,
    SetForegroundWindow, TrackPopupMenuEx, MF_SEPARATOR, MF_STRING, TPM_LEFTALIGN, TPM_NONOTIFY,
    TPM_RETURNCMD, TPM_RIGHTALIGN, TPM_RIGHTBUTTON, TPM_TOPALIGN, WM_NULL,
};

/// What the owner can choose from the dock's menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    /// Over to this side.
    Edge(Edge),
    /// Hidden for an hour.
    Rest,
    /// Nook's panel, where the dock's switch and side are.
    Settings,
    Off,
}

/// The menu is up.
static SHOWING: AtomicBool = AtomicBool::new(false);

pub fn showing() -> bool {
    SHOWING.load(Ordering::SeqCst)
}

/// The menu for a dock on `edge`, top to bottom; None is a line between items. An item's id is
/// its place in the list, from 1, since Windows reads 0 as nothing chosen.
pub fn items(edge: Edge) -> Vec<Option<(Choice, &'static str)>> {
    let other = if edge == Edge::Left {
        (Choice::Edge(Edge::Right), "Move to the &right edge")
    } else {
        (Choice::Edge(Edge::Left), "Move to the &left edge")
    };
    vec![
        Some(other),
        Some((Choice::Rest, "&Hide for an hour")),
        None,
        Some((Choice::Settings, "Dock &settings…")),
        Some((Choice::Off, "&Turn off the dock")),
    ]
}

/// What Windows' answer `id` chose from the menu for `edge`.
pub fn chosen(edge: Edge, id: i32) -> Option<Choice> {
    let at = usize::try_from(id).ok()?.checked_sub(1)?;
    items(edge).get(at).copied().flatten().map(|(c, _)| c)
}

/// Shows the menu at `at`, in physical px, beside the dock's window `w`, and waits for the owner.
/// On the main thread, which it keeps busy until the menu closes, as Windows' menus do.
pub fn show<R: Runtime>(w: &WebviewWindow<R>, edge: Edge, at: (i32, i32)) -> Option<Choice> {
    let ours = w.hwnd().ok()?;
    let menu = unsafe { CreatePopupMenu() }.ok()?;
    for (i, item) in items(edge).into_iter().enumerate() {
        let added = match item {
            Some((_, label)) => unsafe {
                AppendMenuW(menu, MF_STRING, i + 1, &HSTRING::from(label))
            },
            None => unsafe { AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null()) },
        };
        if let Err(e) = added {
            log::warn!("Couldn't make the dock's menu: {e}");
            let _ = unsafe { DestroyMenu(menu) };
            return None;
        }
    }
    // It opens toward the middle of the screen, as the dock's card does.
    let side = if edge == Edge::Right {
        TPM_RIGHTALIGN
    } else {
        TPM_LEFTALIGN
    };
    let flags = TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_TOPALIGN | side;
    let before = unsafe { GetForegroundWindow() };
    SHOWING.store(true, Ordering::SeqCst);
    let id = unsafe {
        let _ = SetForegroundWindow(ours);
        let id = TrackPopupMenuEx(menu, flags.0, at.0, at.1, ours, None);
        // So the next menu opens as it should (TrackPopupMenu's remarks).
        let _ = PostMessageW(Some(ours), WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);
        id.0
    };
    SHOWING.store(false, Ordering::SeqCst);
    give_back(before, ours);
    chosen(edge, id)
}

/// The window in front before the menu gets the foreground back, if the dock still has it: a
/// click on another window while the menu was up already gave that one the foreground.
fn give_back(before: HWND, ours: HWND) {
    if before.is_invalid() || before == ours {
        return;
    }
    unsafe {
        if GetForegroundWindow() == ours && IsWindow(Some(before)).as_bool() {
            let _ = SetForegroundWindow(before);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_offers_the_other_side_and_reads_back_what_was_chosen() {
        let right = items(Edge::Right);
        assert_eq!(
            right[0],
            Some((Choice::Edge(Edge::Left), "Move to the &left edge"))
        );
        assert_eq!(items(Edge::Left)[0].unwrap().0, Choice::Edge(Edge::Right));
        assert_eq!(right.iter().filter(|i| i.is_none()).count(), 1);
        assert_eq!(chosen(Edge::Right, 1), Some(Choice::Edge(Edge::Left)));
        assert_eq!(chosen(Edge::Left, 1), Some(Choice::Edge(Edge::Right)));
        assert_eq!(chosen(Edge::Right, 2), Some(Choice::Rest));
        assert_eq!(chosen(Edge::Right, 4), Some(Choice::Settings));
        assert_eq!(chosen(Edge::Right, 5), Some(Choice::Off));
        // Nothing chosen (Esc, a click elsewhere), the line, and ids Windows never gives.
        for id in [0, 3, 6, -1] {
            assert_eq!(chosen(Edge::Right, id), None, "{id}");
        }
        assert!(!showing());
    }
}
