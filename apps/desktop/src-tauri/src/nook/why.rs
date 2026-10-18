// Why a window gets its verdict, in the words the panel shows under 'Why not tiled' (docs/
// nook-wm.md, "WHY NOT TILED"). Each reason has a short code for filters, tests and fixtures.
// Nothing here ever holds a window's title.

use super::rules::{Action, Origin};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Why {
    OwnProcess,
    NotVisible,
    Child,
    NotRoot,
    Disabled,
    ShellClass(&'static str),
    GameClass(&'static str),
    LikelyGame(&'static str),
    ToolWindow,
    NoActivate,
    ClickThrough,
    BarePopup,
    TooSmall,
    Cloaked,
    CloakUnknown,
    Protected,
    ShellExe(String),
    ExplorerNotFolder,
    GamePath(&'static str),
    Elevated,
    ElevationUnknown,
    OtherDesktop,
    Rule {
        app: String,
        origin: Origin,
        action: Action,
        sticky: bool,
    },
    Owned(String),
    Dialog,
    Topmost,
    FixedSize,
    NoCaption,
    Standard,
}

impl Why {
    pub fn code(&self) -> &'static str {
        match self {
            Why::OwnProcess => "own_process",
            Why::NotVisible => "not_visible",
            Why::Child => "child",
            Why::NotRoot => "not_root",
            Why::Disabled => "disabled",
            Why::ShellClass(_) => "shell_class",
            Why::GameClass(_) => "game_class",
            Why::LikelyGame(_) => "likely_game",
            Why::ToolWindow => "tool_window",
            Why::NoActivate => "no_activate",
            Why::ClickThrough => "click_through",
            Why::BarePopup => "bare_popup",
            Why::TooSmall => "too_small",
            Why::Cloaked => "cloaked",
            Why::CloakUnknown => "cloak_unknown",
            Why::Protected => "protected",
            Why::ShellExe(_) => "shell_exe",
            Why::ExplorerNotFolder => "explorer_not_folder",
            Why::GamePath(_) => "game_path",
            Why::Elevated => "elevated",
            Why::ElevationUnknown => "elevation_unknown",
            Why::OtherDesktop => "other_desktop",
            Why::Rule {
                origin: Origin::User,
                ..
            } => "user_rule",
            Why::Rule { .. } => "default_rule",
            Why::Owned(_) => "owned",
            Why::Dialog => "dialog",
            Why::Topmost => "topmost",
            Why::FixedSize => "fixed_size",
            Why::NoCaption => "no_caption",
            Why::Standard => "standard",
        }
    }

    pub fn text(&self) -> String {
        let fixed = match self {
            Why::OwnProcess => "One of Nook's own windows",
            Why::NotVisible => "Not shown",
            Why::Child | Why::NotRoot => "Part of another window",
            Why::Disabled => "Disabled: its app has a dialog open",
            Why::ToolWindow => "A tool window, not an app window",
            Why::NoActivate => "Never takes focus, like an overlay",
            Why::ClickThrough => "A click-through overlay",
            Why::BarePopup => "A popup without a frame, like a menu or a toast",
            Why::TooSmall => "Smaller than 100 by 50 pixels",
            Why::Cloaked => "Hidden by Windows, or on another desktop",
            Why::CloakUnknown => "Windows didn't say whether it's hidden, so Nook leaves it be",
            Why::Protected => "A protected app: Windows won't let Nook look at it",
            Why::ExplorerNotFolder => "Part of Explorer that isn't a folder window",
            Why::Elevated => "Elevated: Windows won't let Nook move it",
            Why::ElevationUnknown => {
                "Windows won't say whether it runs as administrator, so Nook leaves it be"
            }
            Why::OtherDesktop => "On another virtual desktop",
            Why::Dialog => "A dialog: floats",
            Why::Topmost => "Always on top: floats",
            Why::FixedSize => "Fixed size: floats",
            Why::NoCaption => "No title bar: floats",
            Why::Standard => "A standard app window: Nook can arrange it",
            _ => "",
        };
        if !fixed.is_empty() {
            return fixed.to_string();
        }
        match self {
            Why::ShellClass(class) => format!("Part of Windows ({class}): never touched"),
            Why::GameClass(class) => format!("A game window ({class}): games are never touched"),
            Why::LikelyGame(class) => {
                format!("Likely a game ({class}): left alone unless a rule of yours says otherwise")
            }
            Why::ShellExe(exe) => format!("Part of Windows or an overlay ({exe}): never touched"),
            Why::GamePath(part) => format!("Under {part}: games are never touched"),
            Why::Owned(app) => format!("Owned by {app}: a dialog, floats"),
            Why::Rule {
                app,
                origin,
                action,
                sticky,
            } => rule_text(app, *origin, *action, *sticky),
            _ => String::new(),
        }
    }
}

fn rule_text(app: &str, origin: Origin, action: Action, sticky: bool) -> String {
    if sticky {
        return format!("{app} lives in the tray: floats and stays on every workspace");
    }
    let verb = match action {
        Action::Manage => "can be arranged",
        Action::Float => "floats",
        Action::Ignore => "is left alone",
    };
    match origin {
        Origin::User => format!("Your rule for {app}: it {verb}"),
        Origin::Nook => format!("{app}: it {verb}"),
        Origin::Komorebi => format!("{app}: the shared app list says it {verb}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasons_read_as_the_design_wrote_them() {
        assert_eq!(
            Why::Owned("Discord.exe".into()).text(),
            "Owned by Discord.exe: a dialog, floats"
        );
        assert_eq!(
            Why::GamePath(r"\steamapps\common\").text(),
            r"Under \steamapps\common\: games are never touched"
        );
        assert_eq!(
            Why::Elevated.text(),
            "Elevated: Windows won't let Nook move it"
        );
        assert!(Why::LikelyGame("UnityWndClass")
            .text()
            .starts_with("Likely a game (UnityWndClass)"));
    }

    #[test]
    fn no_reason_shouts_or_is_empty() {
        let all = [
            Why::OwnProcess,
            Why::ShellClass("Progman"),
            Why::Rule {
                app: "Discord".into(),
                origin: Origin::Nook,
                action: Action::Float,
                sticky: true,
            },
            Why::Rule {
                app: "Zoom".into(),
                origin: Origin::Komorebi,
                action: Action::Ignore,
                sticky: false,
            },
            Why::Standard,
            Why::NoCaption,
        ];
        for why in all {
            let text = why.text();
            assert!(!text.is_empty() && !text.contains('!'), "{text}");
            assert!(!why.code().is_empty());
        }
    }
}
