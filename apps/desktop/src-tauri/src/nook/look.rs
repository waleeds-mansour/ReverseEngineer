// What Nook's chrome shows besides the windows, put together (chrome.rs has the shapes): the
// theme Hearth's window chose, what Windows says about transparency, high contrast and
// animation, Hearth's services as the tray reads them, Pip, and the bar's switch. A new view goes
// to Nook's pages only when something in it changed, and nothing here runs while the bar is off
// except remembering a theme, which is a store write.

use super::chrome::{key_caps, ChromeView, Health, PipMood, ServicesView, ThemeId};
use super::host::{self, Shared};
use super::pip::Pip;
use super::surface::{self, Readings};
use super::{barwin, settings, ui};
use crate::hearth::status::{Mark, Status};
use std::sync::Arc;
use tauri::AppHandle;

pub struct Chrome {
    /// The theme Hearth's window last showed; none until it has told Nook one.
    pub chosen: Option<ThemeId>,
    pub pip: Pip,
    readings: Readings,
    last: Option<ChromeView>,
    seq: u64,
}

impl Chrome {
    pub fn new(chosen: Option<ThemeId>) -> Chrome {
        Chrome {
            chosen,
            pip: Pip::default(),
            readings: Readings::default(),
            last: None,
            seq: 0,
        }
    }
}

fn health(m: Mark) -> Health {
    match m {
        Mark::Ok => Health::Ok,
        Mark::Trouble => Health::Trouble,
        Mark::Down => Health::Down,
        Mark::Unknown => Health::Unknown,
    }
}

/// The tray's status, for the bar. Until the first check comes back, everything is unknown.
pub fn services(status: Option<&Status>) -> ServicesView {
    let Some(s) = status else {
        return ServicesView::default();
    };
    ServicesView {
        checked: true,
        address_set: s.address_set,
        server: health(s.server),
        worker: health(s.worker),
        pip: health(s.jarvis),
        pip_paused: s.jarvis_paused,
        other_failing: s.other_failing,
    }
}

fn stop_key(app: &AppHandle) -> Vec<String> {
    let settings = crate::settings::get_settings(app);
    let binding = settings
        .bindings
        .get("cancel")
        .map(|b| b.current_binding.as_str())
        .unwrap_or("escape");
    key_caps(binding)
}

/// The view as it is now, with a new seq when anything in it changed. The bar's own lock is
/// taken and let go before Chrome's, so the two are never held together.
fn view(shared: &Shared) -> (ChromeView, bool) {
    let bar = shared.bar().view();
    let services = services(crate::hearth::status::current().as_ref());
    let stop = stop_key(&shared.app);
    let mut c = shared.chrome();
    let r = c.readings;
    let mut next = ChromeView {
        seq: c.seq,
        theme: ThemeId::resolve(c.chosen, r.dark, r.high_contrast),
        glass: r.transparency && !r.high_contrast,
        reduced_motion: r.reduced_motion,
        services,
        pip: c.pip.view(stop),
        bar,
    };
    let changed = c.last.as_ref().is_none_or(|last| {
        let mut was = last.clone();
        was.seq = next.seq;
        was != next
    });
    if changed {
        c.seq += 1;
        next.seq = c.seq;
        c.last = Some(next.clone());
    }
    (next, changed)
}

/// The view as it is now, for a reply. When it changed, every Nook page hears of it too.
pub fn fresh(shared: &Shared) -> ChromeView {
    let (view, changed) = view(shared);
    if changed {
        ui::emit_chrome(&shared.app, &view);
    }
    view
}

/// Sends the view to Nook's pages when it changed.
pub fn emit(shared: &Shared) {
    let _ = fresh(shared);
}

/// Reads Windows' settings again: at start, when the bar is made, and when nook-shell hears
/// that the theme, transparency or high contrast changed. The bar's acrylic follows.
pub fn read_system(shared: &Shared) {
    let r = surface::readings();
    let glass_was = {
        let mut c = shared.chrome();
        let was = c.readings.transparency && !c.readings.high_contrast;
        c.readings = r;
        was
    };
    let glass = r.transparency && !r.high_contrast;
    if glass != glass_was {
        barwin::set_glass(&shared.app, glass);
    }
    emit(shared);
}

pub fn system_changed(app: &AppHandle) {
    if let Some(shared) = host::shared(app) {
        if shared.bar().made {
            read_system(&shared);
        }
    }
}

/// hearth://theme/<id> from one of Hearth's windows. It is kept whether or not the bar is on, so
/// the bar starts in the theme Hearth's window shows.
pub fn theme(app: &AppHandle, id: ThemeId) {
    let Some(shared) = host::shared(app) else {
        return;
    };
    let same = {
        let mut c = shared.chrome();
        let same = c.chosen == Some(id);
        c.chosen = Some(id);
        same
    };
    if same {
        return;
    }
    if let Err(e) = settings::save_theme(app, id) {
        log::warn!("Couldn't keep Nook's theme: {e}");
    }
    if shared.bar().made {
        emit(&shared);
    }
}

/// The tray's status changed.
pub fn services_changed(app: &AppHandle) {
    if let Some(shared) = host::shared(app) {
        if shared.bar().made {
            emit(&shared);
        }
    }
}

/// Pip's mood changed on this PC. An age-out is scheduled for every mood but idle.
pub fn pip(app: &AppHandle, f: impl FnOnce(&mut Pip) -> (bool, Option<super::pip::AgeOut>)) {
    let Some(shared) = host::shared(app) else {
        return;
    };
    if !shared.bar().made {
        return;
    }
    let (changed, age) = f(&mut shared.chrome().pip);
    if let Some(age) = age {
        age_later(&shared, age);
    }
    if changed {
        emit(&shared);
    }
}

pub fn set_mood(app: &AppHandle, mood: PipMood) {
    pip(app, |p| p.set(mood));
}

fn age_later(shared: &Arc<Shared>, age: super::pip::AgeOut) {
    let s = shared.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(age.after).await;
        let aged = s.chrome().pip.age(age.epoch);
        if aged {
            emit(&s);
        }
    });
}
