// Nook's switches (docs/nook-wm.md, "Principles" and "OPT-IN FLOW"). They live in the app's
// settings store next to Handy's settings, under a key of their own, so a value this version
// can't read turns Nook off without touching the rest. Every switch starts off. This version has
// no window manager to turn on, so for now the switches only decide what Nook's status says.

use log::warn;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// The key in settings_store.json.
pub const STORE_KEY: &str = "nook";

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NookSettings {
    /// The window manager itself, in Manual mode: it arranges only when asked.
    pub enabled: bool,
    /// Arranging the windows of a monitor on demand.
    pub arrange: bool,
    /// New windows of the chosen apps are arranged as they open.
    pub auto_manage: bool,
    pub workspaces: bool,
    pub bar: bool,
    pub ring: bool,
    /// Ctrl+Win+Alt keys beyond Pause and Panic.
    pub keymap: bool,
    /// Space kept for the bar at the screen's edge, as an AppBar.
    pub reserve: bool,
    /// Hiding other workspaces by cloaking instead of minimizing, on verified builds only.
    pub cloak: bool,
    /// Arranging DISPLAY2 as well.
    pub display2: bool,
    /// When the owner last cleared safe start, in unix ms. Unclean ends before it don't count.
    pub safe_start_cleared_at: u64,
}

impl NookSettings {
    /// Whether any capability is switched on.
    pub fn any_on(&self) -> bool {
        // Spelled out field by field, so a switch added later can't be left out of this.
        let NookSettings {
            enabled,
            arrange,
            auto_manage,
            workspaces,
            bar,
            ring,
            keymap,
            reserve,
            cloak,
            display2,
            safe_start_cleared_at: _,
        } = self;
        [
            enabled,
            arrange,
            auto_manage,
            workspaces,
            bar,
            ring,
            keymap,
            reserve,
            cloak,
            display2,
        ]
        .iter()
        .any(|on| **on)
    }
}

/// Nook's settings as stored. Reading never writes: a store without them stays as it was.
pub fn load(app: &AppHandle) -> NookSettings {
    match app.store(crate::portable::store_path(
        crate::settings::SETTINGS_STORE_PATH,
    )) {
        Ok(store) => from_value(store.get(STORE_KEY)),
        Err(e) => {
            warn!("Couldn't open the settings store for Nook, so Nook stays off: {e}");
            NookSettings::default()
        }
    }
}

/// A stored value this version can't read counts as everything off: Nook fails closed.
pub fn from_value(value: Option<serde_json::Value>) -> NookSettings {
    let Some(value) = value else {
        return NookSettings::default();
    };
    serde_json::from_value(value).unwrap_or_else(|e| {
        warn!("Nook's stored settings don't read ({e}), so every capability stays off");
        NookSettings::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn everything_starts_off() {
        let settings = NookSettings::default();
        assert!(!settings.any_on());
        assert_eq!(from_value(None), settings);
    }

    #[test]
    fn a_stored_switch_reads_and_the_rest_stay_off() {
        let settings = from_value(Some(json!({ "bar": true })));
        assert!(settings.bar);
        assert!(!settings.enabled);
        assert!(settings.any_on());
    }

    #[test]
    fn a_value_that_does_not_read_turns_everything_off() {
        let settings = from_value(Some(json!({ "enabled": "yes", "bar": true })));
        assert_eq!(settings, NookSettings::default());
        assert_eq!(from_value(Some(json!("on"))), NookSettings::default());
    }

    #[test]
    fn a_switch_from_a_later_version_is_ignored() {
        let settings = from_value(Some(json!({ "enabled": true, "hologram": true })));
        assert!(settings.enabled);
    }

    #[test]
    fn clearing_safe_start_is_not_a_switch() {
        let settings = from_value(Some(json!({ "safe_start_cleared_at": 5 })));
        assert_eq!(settings.safe_start_cleared_at, 5);
        assert!(!settings.any_on());
    }
}
