// What Nook's chrome shows besides the windows (docs/nook-wm.md, "DATA FOR THE BAR" and "THEME"):
// the theme, whether the glass can be glass, Hearth's services, Pip, and the bar's own switch.
// It goes to Nook's pages as 'nook://chrome' whenever one of them changes, and with every nook_ui
// reply. Rust holds the last of each, so a page draws what it was last told even while Hearth's
// server is restarting.

use serde::{Deserialize, Serialize};
use specta::Type;

/// The event Nook's pages listen for, next to 'nook://state'.
pub const CHROME_EVENT: &str = "nook://chrome";

/// One of Nook's six themes. These are the only values hearth://theme carries; anything else is
/// dropped before it gets here.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ThemeId {
    #[default]
    Light,
    Paper,
    Dark,
    Midnight,
    Dusk,
    Contrast,
}

impl ThemeId {
    pub const ALL: [ThemeId; 6] = [
        ThemeId::Light,
        ThemeId::Paper,
        ThemeId::Dark,
        ThemeId::Midnight,
        ThemeId::Dusk,
        ThemeId::Contrast,
    ];

    pub fn id(self) -> &'static str {
        match self {
            ThemeId::Light => "light",
            ThemeId::Paper => "paper",
            ThemeId::Dark => "dark",
            ThemeId::Midnight => "midnight",
            ThemeId::Dusk => "dusk",
            ThemeId::Contrast => "contrast",
        }
    }

    /// Exactly one of the six ids, as the web app writes them; nothing else, not even "Dark".
    pub fn parse(s: &str) -> Option<ThemeId> {
        ThemeId::ALL.into_iter().find(|t| t.id() == s)
    }

    /// What Nook shows: the theme Hearth's window chose, the system's light or dark until it has
    /// chosen one, and High contrast whenever Windows has it on.
    pub fn resolve(chosen: Option<ThemeId>, system_dark: bool, high_contrast: bool) -> ThemeId {
        if high_contrast {
            return ThemeId::Contrast;
        }
        chosen.unwrap_or(if system_dark {
            ThemeId::Dark
        } else {
            ThemeId::Light
        })
    }
}

/// How one of Hearth's services is, as the tray's status line reads it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Ok,
    Trouble,
    Down,
    #[default]
    Unknown,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct ServicesView {
    /// The first check has come back.
    pub checked: bool,
    /// This app knows Hearth's address.
    pub address_set: bool,
    pub server: Health,
    pub worker: Health,
    pub pip: Health,
    pub pip_paused: bool,
    /// Something else Hearth watches (a sync, the disk, backups) is failing.
    pub other_failing: bool,
}

/// What Pip is doing, as far as this PC knows: listening and thinking are its own calls to Pip
/// (the command and talk keys); happy is the moment an answer comes back.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum PipMood {
    #[default]
    Idle,
    Listening,
    Thinking,
    Happy,
}

impl PipMood {
    /// Whether the island is open.
    pub fn working(self) -> bool {
        matches!(self, PipMood::Listening | PipMood::Thinking)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct PipView {
    pub mood: PipMood,
    /// Goes up with every new mood, so the bar can tell a fresh one from the same one again.
    pub changed: u64,
    /// Notifications Hearth sent since the owner last looked at Hearth's window, like an approval.
    pub waiting: u32,
    /// The key that stops Pip (Hearth's cancel binding), as key caps: ["Esc"].
    pub stop_key: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct BarView {
    /// The owner's switch.
    pub on: bool,
    /// The bar is on the screen now.
    pub shown: bool,
    /// Why there is no bar although the switch is on.
    pub why_not: Option<String>,
    /// The services and Pip popover is open.
    pub popover: bool,
    /// A game or something fullscreen is in front, on any monitor: Pip holds still. On another
    /// monitor than the bar's, the bar stays up.
    pub quiet: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct ChromeView {
    /// Goes up with every new view, so a page can drop one that arrives late.
    pub seq: u64,
    pub theme: ThemeId,
    /// Windows' transparency is on, so the bar is glass; off, it is a solid surface.
    pub glass: bool,
    /// Windows' animation effects are off: nothing moves.
    pub reduced_motion: bool,
    pub services: ServicesView,
    pub pip: PipView,
    pub bar: BarView,
}

/// Hearth's key names as key caps: "ctrl+shift+escape" reads ["Ctrl", "Shift", "Esc"].
pub fn key_caps(binding: &str) -> Vec<String> {
    binding
        .split('+')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(|k| match k.to_ascii_lowercase().as_str() {
            "escape" | "esc" => "Esc".to_string(),
            "ctrl" | "control" => "Ctrl".to_string(),
            "shift" => "Shift".to_string(),
            "alt" | "option" => "Alt".to_string(),
            "super" | "meta" | "win" | "command" | "cmd" => "Win".to_string(),
            "space" => "Space".to_string(),
            other if other.chars().count() == 1 => other.to_ascii_uppercase(),
            other => {
                let mut c = other.chars();
                c.next()
                    .map(|f| f.to_ascii_uppercase().to_string() + c.as_str())
                    .unwrap_or_default()
            }
        })
        .take(4)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_six_ids_read_as_themes() {
        for t in ThemeId::ALL {
            assert_eq!(ThemeId::parse(t.id()), Some(t));
        }
        for bad in [
            "",
            "system",
            "Dark",
            "DARK",
            "dark ",
            "light;",
            "neon",
            "contrast/x",
        ] {
            assert_eq!(ThemeId::parse(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn the_theme_follows_hearth_then_the_system_and_high_contrast_wins() {
        assert_eq!(ThemeId::resolve(None, false, false), ThemeId::Light);
        assert_eq!(ThemeId::resolve(None, true, false), ThemeId::Dark);
        assert_eq!(
            ThemeId::resolve(Some(ThemeId::Dusk), false, false),
            ThemeId::Dusk
        );
        assert_eq!(
            ThemeId::resolve(Some(ThemeId::Paper), true, true),
            ThemeId::Contrast
        );
    }

    #[test]
    fn the_view_reads_in_snake_case() {
        let view = ChromeView {
            theme: ThemeId::Midnight,
            pip: PipView {
                mood: PipMood::Thinking,
                ..PipView::default()
            },
            ..ChromeView::default()
        };
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["theme"], "midnight");
        assert_eq!(json["pip"]["mood"], "thinking");
        assert_eq!(json["services"]["server"], "unknown");
        assert_eq!(json["bar"]["why_not"], serde_json::Value::Null);
    }

    #[test]
    fn bindings_read_as_key_caps() {
        assert_eq!(key_caps("escape"), vec!["Esc"]);
        assert_eq!(key_caps("ctrl+shift+x"), vec!["Ctrl", "Shift", "X"]);
        assert_eq!(key_caps("alt+f4"), vec!["Alt", "F4"]);
        assert!(key_caps("").is_empty());
    }
}
