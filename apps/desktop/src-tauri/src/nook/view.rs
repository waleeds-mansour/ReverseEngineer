// What Nook's own pages see (docs/nook-wm.md, "IPC" and "DATA FOR THE BAR"): NookState, emitted as
// 'nook://state' to Nook's windows and returned by nook_ui, and UiCmd, the one command's argument.
// It carries app names, verdicts and reasons, never a window's title. The panel gets the window
// list; every other Nook window gets the state without it.

use super::chrome::{ChromeView, Edge};
use serde::{Deserialize, Serialize};
use specta::Type;

/// The event Nook's pages listen for.
pub const STATE_EVENT: &str = "nook://state";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ModeName {
    #[default]
    Off,
    /// Hooks only: every write is refused.
    Observing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum VerdictName {
    Tile,
    Float,
    Ignore,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum WindowState {
    #[default]
    Normal,
    Minimized,
    Maximized,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct RectView {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct MonitorView {
    /// The stable device-interface id.
    pub id: String,
    /// "DISPLAY1".
    pub name: String,
    pub rect: RectView,
    pub work: RectView,
    pub dpi: u32,
    pub primary: bool,
    pub managed: bool,
    pub note: String,
}

/// The app in front, for the bar.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct FocusedView {
    /// Its name, like "Google Chrome": the exe's description, or its file name.
    pub app: String,
    pub exe: Option<String>,
    pub verdict: VerdictName,
    pub why: String,
    /// The game guard tripped on it: the bar and popover hide.
    pub game: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct GateView {
    pub name: String,
    pub text: String,
}

/// One row of 'Why not tiled'.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct WindowView {
    /// The handle as "0x...", the way Nook's log and Spy++ show it.
    pub id: String,
    pub app: String,
    pub exe: Option<String>,
    pub class: String,
    pub verdict: VerdictName,
    /// The reason the panel shows: the verdict's, or why an arrangeable window would still be
    /// left where it is (minimized, maximized or on a monitor Nook leaves alone).
    pub why: String,
    pub code: String,
    pub state: WindowState,
    pub monitor: Option<String>,
    pub sticky: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct WriteCounts {
    pub attempted: u64,
    pub refused: u64,
    pub landed: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct NookState {
    /// Goes up with every new state, so a page can drop one that arrives late.
    pub seq: u64,
    pub mode: ModeName,
    /// Why Nook isn't observing, when it isn't.
    pub why_off: Option<String>,
    /// The owner's switch for observing without the panel open.
    pub observe: bool,
    pub panel_open: bool,
    /// Hearth runs as administrator, so Nook will only ever observe.
    pub elevated: bool,
    pub monitors: Vec<MonitorView>,
    pub focused: Option<FocusedView>,
    pub gates: Vec<GateView>,
    pub writes: WriteCounts,
    /// Only for the panel, and only while it is open.
    pub windows: Vec<WindowView>,
    pub problems: Vec<String>,
    /// The window in front, so the bar knows which monitor a game covers, can hand the foreground
    /// back, and closes its popover when another app comes forward. Never sent to a page.
    #[serde(skip)]
    pub front: Option<FrontWindow>,
}

/// What the bar needs of the window in front, as nook-wm last saw it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrontWindow {
    pub hwnd: isize,
    /// Its process, so a handle Windows gave to a new window since isn't taken for it.
    pub pid: u32,
    /// The window's own rect: one that covers the bar's monitor hides the bar. None for the
    /// desktop and Windows' other shell windows, which cover every monitor and hide nothing.
    pub rect: Option<RectView>,
    /// The monitor it is on, when nook-wm knows.
    pub monitor: Option<RectView>,
    /// Whether its process runs elevated; None when Nook didn't read it.
    pub elevated: Option<bool>,
    /// nook-com's answer; None until it has answered.
    pub on_this_desktop: Option<bool>,
    /// The game guard tripped while it was in front.
    pub game: bool,
}

impl NookState {
    /// The state for every Nook window but the panel.
    pub fn without_windows(&self) -> NookState {
        NookState {
            windows: Vec::new(),
            ..self.clone()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UiCmd {
    /// The page has loaded: send it the state.
    Ready,
    /// Look at every window again.
    Refresh,
    /// The observing switch.
    SetObserve { on: bool },
    /// Save what Nook sees about each window, without titles, for the verdict tests.
    SaveFixtures,
    /// Write diag.json now.
    ExportDiag,
    /// The bar's switch.
    SetBar { on: bool },
    /// The bar or popover has drawn its first frame and can be shown.
    Drawn,
    /// The bar opens or closes the services and Pip popover.
    Popover { open: bool },
    /// The popover's Open Hearth: Hearth's window, on Today.
    OpenToday,
    /// The agent dock's switch.
    SetDock { on: bool },
    /// The pointer came over the agent dock, or left it: its card opens or closes.
    DockHover { open: bool },
    /// The side the agent dock sits on, left or right.
    SetDockEdge { edge: Edge },
    /// A right click on the agent dock's strip: its menu, at the pointer.
    DockMenu,
    /// The agent dock's strip was pressed and moved: it follows the pointer until let go.
    DockDrag,
    /// A button on the agent dock's card: a page of Hearth's window.
    DockOpen { page: DockPage },
}

/// What a button on the agent dock's card opens in Hearth's window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum DockPage {
    /// Pip's conversation, with its Stop.
    Conversation,
    /// Today, where what waits for the owner's yes is listed.
    Approvals,
    /// Hearth's health, in Settings.
    Status,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct UiReply {
    pub state: NookState,
    /// Where a saved file went.
    pub saved: Option<String>,
    pub chrome: ChromeView,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_read_as_the_page_sends_them() {
        let read = |s: &str| serde_json::from_str::<UiCmd>(s).unwrap();
        assert_eq!(read(r#"{"kind":"ready"}"#), UiCmd::Ready);
        assert_eq!(
            read(r#"{"kind":"set_observe","on":true}"#),
            UiCmd::SetObserve { on: true }
        );
        assert!(serde_json::from_str::<UiCmd>(r#"{"kind":"arrange"}"#).is_err());
        assert!(serde_json::from_str::<UiCmd>(r#"{"kind":"set_observe","on":"yes"}"#).is_err());
        assert_eq!(
            read(r#"{"kind":"popover","open":false}"#),
            UiCmd::Popover { open: false }
        );
        assert_eq!(read(r#"{"kind":"drawn"}"#), UiCmd::Drawn);
        assert_eq!(
            read(r#"{"kind":"set_dock","on":false}"#),
            UiCmd::SetDock { on: false }
        );
        assert_eq!(
            read(r#"{"kind":"dock_hover","open":true}"#),
            UiCmd::DockHover { open: true }
        );
        assert_eq!(
            read(r#"{"kind":"set_dock_edge","edge":"right"}"#),
            UiCmd::SetDockEdge { edge: Edge::Right }
        );
        assert_eq!(
            read(r#"{"kind":"dock_open","page":"status"}"#),
            UiCmd::DockOpen {
                page: DockPage::Status
            }
        );
        assert!(serde_json::from_str::<UiCmd>(r#"{"kind":"dock_open","page":"/api"}"#).is_err());
        assert!(serde_json::from_str::<UiCmd>(r#"{"kind":"theme","id":"dark"}"#).is_err());
    }

    #[test]
    fn the_state_reads_in_snake_case() {
        let state = NookState {
            mode: ModeName::Observing,
            ..NookState::default()
        };
        let json = serde_json::to_value(&state).unwrap();
        assert_eq!(json["mode"], "observing");
        assert_eq!(json["panel_open"], false);
        assert!(json["windows"].as_array().unwrap().is_empty());
        let state = NookState {
            front: Some(FrontWindow {
                hwnd: 0x1234,
                ..FrontWindow::default()
            }),
            ..NookState::default()
        };
        let json = serde_json::to_value(&state).unwrap();
        assert!(
            json.get("front").is_none(),
            "a window handle never reaches a page"
        );
    }
}
