// Nook's switches (docs/nook-wm.md, "Principles" and "OPT-IN FLOW"). They live in the app's
// settings store next to Handy's settings, under a key of their own, so a value this version
// can't read turns Nook off without touching the rest. Every switch starts off but the agent
// dock's. This version can't arrange anything yet, so the arranging switches only decide what
// Nook's status says; the ones it acts on are `observe`, which watches windows and writes nothing,
// `bar`, the strip along the top of DISPLAY1 that observes too, and `dock`, the edge tab of status
// dots, which observes nothing and starts on, with `dock_sounds`, its short tones, on as well. The
// theme Hearth's window last showed is kept beside them.

use super::chrome::ThemeId;
use log::warn;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// The key in settings_store.json.
pub const STORE_KEY: &str = "nook";
/// The theme Hearth's window last showed, as one of the six ids.
pub const THEME_KEY: &str = "nook_theme";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct NookSettings {
    /// The window manager itself, in Manual mode: it arranges only when asked.
    pub enabled: bool,
    /// Arranging the windows of a monitor on demand.
    pub arrange: bool,
    /// New windows of the chosen apps are arranged as they open.
    pub auto_manage: bool,
    pub workspaces: bool,
    /// The Nook bar along the top of DISPLAY1, in Overlay mode (P1). It observes while it is on.
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
    /// Observing without the panel open (P1): hooks, verdicts and gates, with every write refused.
    pub observe: bool,
    /// The agent dock: Pip's and the services' status dots on a side of the screen, topmost. It
    /// needs no hook and writes nothing, so it starts on.
    pub dock: bool,
    /// The dock's short tones (its menu's Sounds): something new waits, a service has trouble,
    /// Pip finished. Quiet and rare, so they start on.
    pub dock_sounds: bool,
}

impl Default for NookSettings {
    fn default() -> NookSettings {
        NookSettings {
            dock: true,
            dock_sounds: true,
            ..NookSettings::off()
        }
    }
}

impl NookSettings {
    /// Every switch off, the dock's too: what a store Nook can't read stands for.
    pub fn off() -> NookSettings {
        NookSettings {
            enabled: false,
            arrange: false,
            auto_manage: false,
            workspaces: false,
            bar: false,
            ring: false,
            keymap: false,
            reserve: false,
            cloak: false,
            display2: false,
            safe_start_cleared_at: 0,
            observe: false,
            dock: false,
            dock_sounds: false,
        }
    }

    /// Whether any capability is switched on.
    pub fn any_on(&self) -> bool {
        // Spelled out field by field, so a switch added later can't be left out of this.
        let NookSettings {
            enabled,
            arrange,
            auto_manage,
            workspaces,
            ring,
            keymap,
            reserve,
            cloak,
            display2,
            safe_start_cleared_at: _,
            // Observing changes no window, the bar only observes and the dock only shows (and
            // chimes), so none of them is arranging.
            observe: _,
            bar: _,
            dock: _,
            dock_sounds: _,
        } = self;
        [
            enabled,
            arrange,
            auto_manage,
            workspaces,
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
            NookSettings::off()
        }
    }
}

fn store(app: &AppHandle) -> Result<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>, String> {
    app.store(crate::portable::store_path(
        crate::settings::SETTINGS_STORE_PATH,
    ))
    .map_err(|e| e.to_string())
}

/// Turns observing on or off. Only that key changes, so switches this version can't read stay
/// as they were.
pub fn save_observe(app: &AppHandle, on: bool) -> Result<(), String> {
    let store = store(app)?;
    store.set(STORE_KEY, with_switch(store.get(STORE_KEY), "observe", on));
    Ok(())
}

/// Turns the bar on or off, the same way.
pub fn save_bar(app: &AppHandle, on: bool) -> Result<(), String> {
    let store = store(app)?;
    store.set(STORE_KEY, with_switch(store.get(STORE_KEY), "bar", on));
    Ok(())
}

/// Turns the agent dock on or off, the same way.
pub fn save_dock(app: &AppHandle, on: bool) -> Result<(), String> {
    let store = store(app)?;
    store.set(STORE_KEY, with_switch(store.get(STORE_KEY), "dock", on));
    Ok(())
}

/// Turns the dock's sounds on or off, the same way.
pub fn save_dock_sounds(app: &AppHandle, on: bool) -> Result<(), String> {
    let store = store(app)?;
    store.set(
        STORE_KEY,
        with_switch(store.get(STORE_KEY), "dock_sounds", on),
    );
    Ok(())
}

pub fn with_switch(value: Option<serde_json::Value>, key: &str, on: bool) -> serde_json::Value {
    let mut map = match value {
        Some(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    map.insert(key.into(), serde_json::Value::Bool(on));
    serde_json::Value::Object(map)
}

/// The theme Hearth's window last showed; none until it has told Nook one.
pub fn load_theme(app: &AppHandle) -> Option<ThemeId> {
    let value = store(app).ok()?.get(THEME_KEY)?;
    value.as_str().and_then(ThemeId::parse)
}

pub fn save_theme(app: &AppHandle, theme: ThemeId) -> Result<(), String> {
    store(app)?.set(THEME_KEY, serde_json::Value::String(theme.id().into()));
    Ok(())
}

/// No stored value is the defaults; one this version can't read counts as everything off, the
/// dock too: Nook fails closed.
pub fn from_value(value: Option<serde_json::Value>) -> NookSettings {
    let Some(value) = value else {
        return NookSettings::default();
    };
    serde_json::from_value(value).unwrap_or_else(|e| {
        warn!("Nook's stored settings don't read ({e}), so every capability stays off");
        NookSettings::off()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn everything_starts_off_but_the_dock() {
        let settings = NookSettings::default();
        assert!(!settings.any_on());
        assert!(!settings.observe && !settings.bar);
        assert!(settings.dock, "the agent dock starts on");
        assert!(settings.dock_sounds, "and so do its sounds");
        assert_eq!(from_value(None), settings);
        // A store from before the dock keeps its switches and gets the dock on, sounds and all.
        let older = from_value(Some(json!({ "bar": true })));
        assert!(older.bar && older.dock && older.dock_sounds);
        let off = from_value(Some(json!({ "dock": false })));
        assert!(!off.dock && off.dock_sounds);
        let quiet = from_value(Some(json!({ "dock_sounds": false })));
        assert!(quiet.dock && !quiet.dock_sounds);
        assert!(!NookSettings::off().dock_sounds);
        assert_eq!(
            with_switch(Some(json!({ "bar": true })), "dock", false),
            json!({ "bar": true, "dock": false })
        );
    }

    #[test]
    fn a_stored_switch_reads_and_the_rest_stay_off() {
        let settings = from_value(Some(json!({ "ring": true })));
        assert!(settings.ring);
        assert!(!settings.enabled);
        assert!(settings.any_on());
    }

    #[test]
    fn a_value_that_does_not_read_turns_everything_off() {
        let settings = from_value(Some(json!({ "enabled": "yes", "bar": true })));
        assert_eq!(settings, NookSettings::off());
        assert!(!settings.dock);
        assert_eq!(from_value(Some(json!("on"))), NookSettings::off());
    }

    #[test]
    fn a_switch_from_a_later_version_is_ignored() {
        let settings = from_value(Some(json!({ "enabled": true, "hologram": true })));
        assert!(settings.enabled);
    }

    #[test]
    fn observing_and_the_bar_are_not_arranging_and_saving_them_keeps_the_rest() {
        let settings = from_value(Some(json!({ "observe": true, "bar": true })));
        assert!(settings.observe && settings.bar);
        assert!(!settings.any_on());
        let saved = with_switch(
            Some(json!({ "ring": true, "hologram": 3 })),
            "observe",
            true,
        );
        assert_eq!(
            saved,
            json!({ "ring": true, "hologram": 3, "observe": true })
        );
        assert_eq!(
            with_switch(Some(json!("on")), "bar", false),
            json!({ "bar": false })
        );
        assert_eq!(
            with_switch(None, "observe", true),
            json!({ "observe": true })
        );
    }

    #[test]
    fn clearing_safe_start_is_not_a_switch() {
        let settings = from_value(Some(json!({ "safe_start_cleared_at": 5 })));
        assert_eq!(settings.safe_start_cleared_at, 5);
        assert!(!settings.any_on());
    }
}
