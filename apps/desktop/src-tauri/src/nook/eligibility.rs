// Which windows Nook would arrange (docs/nook-wm.md, "Which windows Nook manages"). The verdict
// is staged from cheap to expensive and the first match wins:
// - Stage A, local user32 facts: Nook's own windows, hidden, child and disabled windows, the
//   shell's classes, game classes, tool windows, overlays, bare popups and tiny windows.
// - Stage B, DWM: a cloaked window, or one whose cloak can't be read, is left alone.
// - The rules that can ignore a window by class alone, so it is decided without its process.
// - Stage C, the process, opened for limited information only: the shell's and overlays' exes,
//   Explorer's non-folder windows, game folders, and elevated windows.
// - Stage D, the virtual desktop, from vd.rs's cache.
// - Rules, the owner's before the defaults; then the heuristics: owned windows, dialogs,
//   topmost, fixed-size and captionless windows float, and the rest can be arranged.
// A game class is matched before any process is opened, so Nook never opens a game's process for
// a window it would ignore anyway.

use super::probe::style::*;
use super::probe::{Closed, Elevation, Hwnd, Own, Probe, ProcessFacts, WindowFacts};
use super::rules::{Action, Flag, Known, Lookup, Rule, Rules, Tried};
use super::why::Why;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// Nook could arrange it.
    Tile,
    /// Never tiled, but it belongs to a workspace.
    Float,
    /// Never touched.
    Ignore,
}

/// Where the verdict was decided, so tests can check the order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Stage {
    A,
    B,
    EarlyRule,
    C,
    D,
    Rule,
    Heuristic,
}

#[derive(Clone, Debug)]
pub struct Verdict {
    pub kind: Kind,
    pub why: Why,
    pub stage: Stage,
    pub flags: Vec<Flag>,
    pub facts: WindowFacts,
    pub cloaked: Option<u32>,
    /// The window's own process, when Stage C opened it.
    pub process: Option<ProcessFacts>,
    /// For a UWP frame, the app inside it: its pid and process.
    pub inner: Option<(u32, ProcessFacts)>,
    /// The app's exe: for a UWP frame, the app inside it.
    pub exe: Option<String>,
    /// How many times this verdict opened a process.
    pub opened: u8,
}

/// Shell windows, by class and never by process name alone.
pub const SHELL_CLASSES: &[&str] = &[
    "Progman",
    "WorkerW",
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland",
    "XamlExplorerHostIslandWindow",
    "MultitaskingViewFrame",
    "ForegroundStaging",
    "TaskListThumbnailWnd",
    "Windows.Internal.Shell.TabProxyWindow",
    "ApplicationManager_ImmersiveShellWindow",
    "EdgeUiInputTopWndClass",
    "Shell_InputSwitchTopLevelWindow",
    "#32768",
    "#32769",
    "tooltips_class32",
    "SysShadow",
    "IME",
    "MSCTFIME UI",
    "Ghost",
    "CEF-OSC-WIDGET",
];

/// Riot's game window and League's client: a hard deny the owner can't override.
pub const GAME_CLASSES: &[&str] = &["RiotWindowClass", "RCLIENT"];

/// Engines' window classes: likely a game, which a rule of the owner's can override.
pub const LIKELY_GAME_CLASSES: &[&str] = &[
    "UnrealWindow",
    "UnityWndClass",
    "CryENGINE",
    "SDL_app",
    "GLFW30",
];

/// The shell's, the overlays' and the anti-cheat's exes, lowercase.
pub const SHELL_EXES: &[&str] = &[
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "searchapp.exe",
    "lockapp.exe",
    "textinputhost.exe",
    "shellhost.exe",
    "widgets.exe",
    "widgetboard.exe",
    "gamebar.exe",
    "gamebarftserver.exe",
    "nvidia overlay.exe",
    "nvcontainer.exe",
    "wallpaper32.exe",
    "wallpaper64.exe",
    "webwallpaper32.exe",
    "wallpaperservice32.exe",
    "vgtray.exe",
    "vgc.exe",
    "overwolfhelper.exe",
    "overwolfhelper64.exe",
    "overwolftshelper.exe",
];

/// Game folders, matched as a case-insensitive part of the image path.
pub const GAME_PATHS: &[&str] = &[
    r"\steamapps\common\",
    r"\Epic Games\",
    r"\EA Games\",
    r"\Riot Games\",
    r"\XboxGames\",
];

/// Epic's own launcher lives under its games folder and is not a game.
const EPIC_LAUNCHER: &str = r"\epic games\launcher\";

pub fn game_path(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    if lower.contains(EPIC_LAUNCHER) {
        return None;
    }
    GAME_PATHS
        .iter()
        .copied()
        .find(|part| lower.contains(&part.to_ascii_lowercase()))
}

fn listed(list: &'static [&'static str], class: &str) -> Option<&'static str> {
    list.iter().copied().find(|c| c.eq_ignore_ascii_case(class))
}

/// The desktop, the taskbar and Windows' other shell windows.
pub fn shell_class(class: &str) -> bool {
    listed(SHELL_CLASSES, class).is_some()
}

/// The staged verdict for `hwnd`, or None when the window is gone. `on_this_desktop` is the
/// cached virtual-desktop answer; None means not known yet, and Stage B has already left alone
/// the windows Windows cloaks for other desktops.
pub fn decide(
    probe: &dyn Probe,
    own: Own,
    rules: &Rules,
    hwnd: Hwnd,
    on_this_desktop: Option<bool>,
) -> Option<Verdict> {
    let facts = probe.window(hwnd)?;
    let mut v = Verdict {
        kind: Kind::Ignore,
        why: Why::Standard,
        stage: Stage::A,
        flags: Vec::new(),
        facts,
        cloaked: None,
        process: None,
        inner: None,
        exe: None,
        opened: 0,
    };
    if let Some(why) = stage_a(&v.facts, own, rules) {
        return Some(v.ignore(Stage::A, why));
    }

    v.cloaked = probe.cloaked(hwnd);
    match v.cloaked {
        None => return Some(v.ignore(Stage::B, Why::CloakUnknown)),
        Some(c) if c != 0 => return Some(v.ignore(Stage::B, Why::Cloaked)),
        Some(_) => {}
    }

    let class = v.facts.class.clone();
    let mut read_title = || probe.title(hwnd);
    let early = rules.first(&mut Known {
        class: &class,
        exe: None,
        path: None,
        title: &mut read_title,
    });
    if let Lookup::Found(rule) = early {
        if rule.action == Action::Ignore {
            return Some(v.by_rule(Stage::EarlyRule, rule));
        }
    }

    v.opened += 1;
    let host = match probe.process(v.facts.pid) {
        Ok(p) => p,
        Err(Closed::Gone) => return None,
        Err(Closed::Denied) => return Some(v.ignore(Stage::C, Why::Protected)),
    };
    let mut app = host.clone();
    if class == "ApplicationFrameWindow"
        && host.exe().eq_ignore_ascii_case("ApplicationFrameHost.exe")
    {
        if let Some(pid) = probe.uwp_child_pid(hwnd).filter(|&p| p != v.facts.pid) {
            v.opened += 1;
            if let Ok(inner) = probe.process(pid) {
                v.inner = Some((pid, inner.clone()));
                app = inner;
            }
        }
    }
    let exe = app.exe().to_string();
    v.exe = Some(exe.clone());
    v.process = Some(host.clone());
    if let Some(e) = listed(SHELL_EXES, &exe) {
        return Some(v.ignore(Stage::C, Why::ShellExe(e.to_string())));
    }
    if host.exe().eq_ignore_ascii_case("explorer.exe") && class != "CabinetWClass" {
        return Some(v.ignore(Stage::C, Why::ExplorerNotFolder));
    }
    if let Some(part) = game_path(&app.path).or_else(|| game_path(&host.path)) {
        return Some(v.ignore(Stage::C, Why::GamePath(part)));
    }
    // Windows keeps a program from moving the windows of one with more rights (UIPI).
    if !own.elevated {
        match host.elevation {
            Elevation::No => {}
            Elevation::Yes => return Some(v.ignore(Stage::C, Why::Elevated)),
            Elevation::Unknown => return Some(v.ignore(Stage::C, Why::ElevationUnknown)),
        }
    }

    if on_this_desktop == Some(false) {
        return Some(v.ignore(Stage::D, Why::OtherDesktop));
    }

    let found = rules.first(&mut Known {
        class: &class,
        exe: Some(&exe),
        path: Some(&app.path),
        title: &mut read_title,
    });
    if let Lookup::Found(rule) = found {
        return Some(v.by_rule(Stage::Rule, rule));
    }
    Some(heuristics(v, &exe))
}

/// Stage A: everything decided from user32 facts alone.
fn stage_a(f: &WindowFacts, own: Own, rules: &Rules) -> Option<Why> {
    if f.pid == own.pid {
        return Some(Why::OwnProcess);
    }
    if !f.visible {
        return Some(Why::NotVisible);
    }
    if f.style & WS_CHILD != 0 {
        return Some(Why::Child);
    }
    if !f.root {
        return Some(Why::NotRoot);
    }
    if f.style & WS_DISABLED != 0 {
        return Some(Why::Disabled);
    }
    if let Some(class) = listed(SHELL_CLASSES, &f.class) {
        return Some(Why::ShellClass(class));
    }
    if let Some(class) = listed(GAME_CLASSES, &f.class) {
        return Some(Why::GameClass(class));
    }
    if let Some(class) = listed(LIKELY_GAME_CLASSES, &f.class) {
        if !owner_allows(rules, &f.class) {
            return Some(Why::LikelyGame(class));
        }
    }
    let ex = f.ex_style;
    if ex & WS_EX_TOOLWINDOW != 0 && ex & WS_EX_APPWINDOW == 0 {
        return Some(Why::ToolWindow);
    }
    if ex & WS_EX_NOACTIVATE != 0 {
        return Some(Why::NoActivate);
    }
    if ex & WS_EX_LAYERED != 0 && ex & WS_EX_TRANSPARENT != 0 {
        return Some(Why::ClickThrough);
    }
    if f.style & WS_POPUP != 0 && f.style & (WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX) == 0 {
        return Some(Why::BarePopup);
    }
    if f.rect.width() < 100 || f.rect.height() < 50 {
        return Some(Why::TooSmall);
    }
    None
}

/// Whether one of the owner's rules takes a likely-game class out of Ignore. It must match by
/// class: a rule that needs the exe would need the process opened, which is what this avoids.
fn owner_allows(rules: &Rules, class: &str) -> bool {
    let mut no_title = || None;
    let mut known = Known {
        class,
        exe: None,
        path: None,
        title: &mut no_title,
    };
    for rule in &rules.user {
        match rule.try_match(&mut known) {
            Tried::Yes => return rule.action != Action::Ignore,
            Tried::NeedsProcess => return false,
            Tried::No => {}
        }
    }
    false
}

fn heuristics(v: Verdict, exe: &str) -> Verdict {
    let f = &v.facts;
    let why = if f.owner != 0 || !f.alt_tab_root {
        Why::Owned(exe.to_string())
    } else if f.class == "#32770" {
        Why::Dialog
    } else if f.ex_style & WS_EX_TOPMOST != 0 {
        Why::Topmost
    } else if f.style & WS_THICKFRAME == 0 || f.style & WS_MAXIMIZEBOX == 0 {
        Why::FixedSize
    } else if f.style & WS_CAPTION != WS_CAPTION {
        Why::NoCaption
    } else {
        return v.set(Kind::Tile, Stage::Heuristic, Why::Standard);
    };
    v.set(Kind::Float, Stage::Heuristic, why)
}

impl Verdict {
    /// The app's image path: the UWP app's inside a frame, otherwise the window's own.
    pub fn app_path(&self) -> Option<&str> {
        self.inner
            .as_ref()
            .map(|(_, p)| p.path.as_str())
            .or(self.process.as_ref().map(|p| p.path.as_str()))
    }

    fn set(mut self, kind: Kind, stage: Stage, why: Why) -> Verdict {
        self.kind = kind;
        self.stage = stage;
        self.why = why;
        self
    }

    fn ignore(self, stage: Stage, why: Why) -> Verdict {
        self.set(Kind::Ignore, stage, why)
    }

    fn by_rule(mut self, stage: Stage, rule: &Rule) -> Verdict {
        self.flags = rule.flags.clone();
        let kind = match rule.action {
            Action::Manage => Kind::Tile,
            Action::Float => Kind::Float,
            Action::Ignore => Kind::Ignore,
        };
        let why = Why::Rule {
            app: rule.app.clone(),
            origin: rule.origin,
            action: rule.action,
            sticky: rule.flags.contains(&Flag::NoHide),
        };
        self.set(kind, stage, why)
    }
}

#[cfg(test)]
mod tests;
