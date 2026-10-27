// Nook's bar and popover windows, made, shown and destroyed as bar.rs decides (docs/nook-wm.md,
// "BAR BUILDER" and "WINDOWS"). The switch makes both windows hidden; the bar is shown once its
// page has drawn and the observer says nothing fullscreen is in front, and the popover waits
// hidden and suspended until the bar asks for it. Turning the switch off destroys both. Making
// and destroying windows waits on the main thread, so it runs on a blocking thread, one sync at a
// time and with no lock of Nook's held; everything done to a window that exists runs on the main
// thread, in order. With the switch off, none of this starts a thread.

use super::bar::{self, Step, Which, BAR_HEIGHT, BAR_LABEL, BAR_PAGE, POPOVER_LABEL, POPOVER_PAGE};
use super::diag::{self, Event};
use super::host::{self, Shared};
use super::probe::Hwnd;
use super::view::NookState;
use super::wm::Cmd;
use super::{focus, look, observe, surface, ui};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// How long the bar's page has to draw its first frame before its windows are made again, once.
const DRAW_WITHIN: Duration = Duration::from_secs(3);
/// Each making of the windows, so a late check for one never acts on the next.
static MAKES: AtomicU64 = AtomicU64::new(0);

/// Brings the bar to what its switch and Nook's status say.
pub fn sync(shared: &Arc<Shared>) {
    let idle = {
        let mut run = shared.bar();
        if !run.setting {
            run.why_not = None;
        }
        !run.setting && !run.made
    };
    if idle {
        // Off and never made: no thread, and the observer isn't kept running for the bar.
        observer(shared, false);
        return;
    }
    let s = shared.clone();
    tauri::async_runtime::spawn_blocking(move || sync_now(&s));
}

fn sync_now(shared: &Arc<Shared>) {
    let _one = shared.bar_sync.lock().unwrap_or_else(|p| p.into_inner());
    let faulted = shared.observer().faulted;
    let (want, made) = {
        let mut run = shared.bar();
        let want = bar::wanted(run.setting, shared.status(), faulted);
        // A bar given up on (BarRun::undrawn) keeps saying why, until its page draws after all.
        let given_up = run.remade && run.made && !run.bar_drawn;
        run.why_not = want.err().or(if given_up { run.why_not } else { None });
        (want, run.made)
    };
    match (want, made) {
        (Ok(()), false) => match make(shared) {
            Ok(ours) => {
                {
                    let mut run = shared.bar();
                    run.made = true;
                    run.ours = ours;
                }
                tell_own(shared);
                must_draw(shared, MAKES.fetch_add(1, Ordering::SeqCst) + 1);
                diag::write(
                    &shared.dir,
                    &Event::Bar {
                        on: true,
                        why: "its switch is on",
                    },
                );
                look::read_system(shared);
                observer(shared, true);
                // The observer may already be running for the panel, with nothing new to say.
                let state = observe::current(shared, &shared.observer());
                on_state(shared, &state);
            }
            Err(e) => {
                log::warn!("Couldn't make Nook's bar: {e}");
                destroy(&shared.app);
                shared.bar().why_not = Some("The bar's window didn't open; nook.log says more");
            }
        },
        (Err(why), true) => {
            destroy(&shared.app);
            {
                let mut run = shared.bar();
                *run = bar::BarRun {
                    setting: run.setting,
                    why_not: run.why_not,
                    ..bar::BarRun::default()
                };
            }
            tell_own(shared);
            diag::write(&shared.dir, &Event::Bar { on: false, why });
            observer(shared, false);
        }
        _ => {}
    }
    look::emit(shared);
}

/// A bar whose page never says it drew would stay hidden for good: after DRAW_WITHIN its windows
/// are made again, and if that one doesn't draw either it is left hidden, saying why.
fn must_draw(shared: &Arc<Shared>, made: u64) {
    let s = shared.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(DRAW_WITHIN).await;
        tauri::async_runtime::spawn_blocking(move || undrawn(&s, made));
    });
}

fn undrawn(shared: &Arc<Shared>, made: u64) {
    let again = {
        let _one = shared.bar_sync.lock().unwrap_or_else(|p| p.into_inner());
        if MAKES.load(Ordering::SeqCst) != made {
            return;
        }
        let Some(again) = shared.bar().undrawn() else {
            return;
        };
        log::warn!(
            "Nook's bar didn't draw within {} s; {}",
            DRAW_WITHIN.as_secs(),
            if again {
                "making it again"
            } else {
                "it stays hidden"
            }
        );
        let why = "its page didn't draw in time";
        diag::write(&shared.dir, &Event::Bar { on: false, why });
        if again {
            destroy(&shared.app);
            tell_own(shared);
        }
        again
    };
    if again {
        sync_now(shared);
    } else {
        look::emit(shared);
    }
}

/// Tells a running nook-wm which windows are Nook's own (the bar's and the dock's), never to be
/// taken for the window in front. One that starts later reads them itself. Never call it holding
/// the bar's or the dock's lock.
pub(super) fn tell_own(shared: &Shared) {
    let ours = shared.own_windows();
    if let Some(link) = shared.observer().link() {
        link.send(Cmd::Chrome(ours));
    }
}

/// Keeps the observer running for the bar, and has nook-wm follow the app in front with F1 while
/// it does, to see a window go fullscreen.
fn observer(shared: &Arc<Shared>, on: bool) {
    let mut o = shared.observer();
    if o.bar == on {
        return;
    }
    o.bar = on;
    if let Some(link) = o.link() {
        link.send(Cmd::FollowForeground(on));
    }
    observe::sync_with(shared, &mut o);
}

fn acrylic() -> tauri::utils::config::WindowEffectsConfig {
    EffectsBuilder::new().effect(Effect::Acrylic).build()
}

/// Both windows, hidden, and their handles. Overlay mode: not topmost, reserving nothing.
fn make(shared: &Shared) -> Result<Vec<Hwnd>, String> {
    let app = &shared.app;
    let (x, y, width) = match app.primary_monitor().ok().flatten() {
        Some(m) => {
            let s = m.scale_factor();
            let (p, size) = (m.position(), m.size());
            (
                f64::from(p.x) / s,
                f64::from(p.y) / s,
                f64::from(size.width) / s,
            )
        }
        None => (0.0, 0.0, 1280.0),
    };
    let glass = {
        let r = surface::readings();
        r.transparency && !r.high_contrast
    };
    let mut b = builder(app, BAR_LABEL, BAR_PAGE)
        .position(x, y)
        .inner_size(width, f64::from(BAR_HEIGHT));
    if glass {
        b = b.effects(acrylic());
    }
    let bar_window = b.build().map_err(|e| e.to_string())?;
    let (pw, ph) = bar::POPOVER_SIZE;
    let pop = builder(app, POPOVER_LABEL, POPOVER_PAGE)
        .position(x + width - f64::from(pw + 8), y + f64::from(BAR_HEIGHT))
        .inner_size(f64::from(pw), f64::from(ph))
        .build()
        .map_err(|e| e.to_string())?;
    let ours = [&bar_window, &pop]
        .iter()
        .filter_map(|w| w.hwnd().ok().map(|h| h.0 as Hwnd))
        .collect();
    let _ = app.run_on_main_thread(move || {
        surface::own_style(&bar_window);
        surface::own_style(&pop);
    });
    Ok(ours)
}

pub(super) fn builder<'a>(
    app: &'a AppHandle,
    label: &str,
    page: &str,
) -> WebviewWindowBuilder<'a, tauri::Wry, AppHandle> {
    let nav = app.clone();
    let mut b = WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title("Nook")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .focusable(false)
        .focused(false)
        .visible(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .always_on_top(false)
        // Nook's pages stay on their own page; they have no links to follow.
        .on_navigation(move |to| ui::is_local(&nav, to));
    if let Some(data) = crate::portable::data_dir() {
        b = b.data_directory(data.join("webview"));
    }
    b
}

fn destroy(app: &AppHandle) {
    for label in [POPOVER_LABEL, BAR_LABEL] {
        if let Some(w) = app.get_webview_window(label) {
            if let Err(e) = w.destroy() {
                log::warn!("Couldn't close Nook's {label}: {e}");
            }
        }
    }
}

/// A new state from nook-wm, or Nook stopping. Called with no lock but the observer's held.
pub fn on_state(shared: &Shared, state: &NookState) {
    let moved = {
        let mut run = shared.bar();
        if !run.made {
            return;
        }
        let seen = |r: &bar::BarRun| {
            (
                r.bar_visible(),
                r.popover_visible(),
                r.monitor,
                r.game_anywhere,
            )
        };
        let before = seen(&run);
        run.take(state);
        before != seen(&run)
    };
    if moved {
        nudge(&shared.app);
        look::emit(shared);
    }
}

/// The bar or popover page drew its first frame.
pub fn drawn(shared: &Shared, label: &str) {
    {
        let mut run = shared.bar();
        match label {
            BAR_LABEL => run.bar_drawn = true,
            POPOVER_LABEL => run.popover_drawn = true,
            _ => return,
        }
    }
    nudge(&shared.app);
}

/// The bar opened or closed its popover.
pub fn popover(shared: &Shared, open: bool) {
    {
        let mut run = shared.bar();
        run.popover_wanted = open && run.popover_allowed();
    }
    nudge(&shared.app);
    look::emit(shared);
}

/// The bar's acrylic, on or off as Windows' transparency and high contrast say.
pub fn set_glass(app: &AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window(BAR_LABEL) {
        let _ = w.set_effects(if on { Some(acrylic()) } else { None });
    }
}

/// Carries out bar.rs's plan on the main thread. Never call it holding the bar's lock: on the
/// main thread it runs at once.
pub fn nudge(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || reconcile(&a));
}

fn reconcile(app: &AppHandle) {
    let Some(shared) = host::shared(app) else {
        return;
    };
    let steps = shared.bar().plan();
    let window = |w: Which| {
        app.get_webview_window(match w {
            Which::Bar => BAR_LABEL,
            Which::Popover => POPOVER_LABEL,
        })
    };
    for step in steps {
        match step {
            Step::Place { bar, popover } => {
                if let Some(w) = window(Which::Bar) {
                    surface::place(&w, bar);
                }
                if let Some(w) = window(Which::Popover) {
                    surface::place(&w, popover);
                }
            }
            Step::Wake(which) => {
                if let Some(w) = window(which) {
                    surface::wake(&w);
                    ui::send_latest(&shared, w.label());
                }
            }
            Step::Show(which) => window(which).iter().for_each(surface::show),
            Step::Hide(which) => window(which).iter().for_each(surface::hide),
            Step::Sleep(which) => window(which).iter().for_each(surface::sleep),
            Step::NcActivate => window(Which::Bar).iter().for_each(surface::nc_activate),
        }
    }
}

/// One of Hearth's windows was focused. When a click really brought the bar or its popover to
/// the front, focus.rs may hand the foreground back to the window before them; Hearth's own
/// window being looked at clears what waits on the Pip chip; any other of Hearth's windows closes
/// the popover.
pub fn focused(app: &AppHandle, label: &str) {
    let Some(shared) = host::shared(app) else {
        return;
    };
    let (made, before) = {
        let run = shared.bar();
        (run.made, run.before)
    };
    let ours = shared.own_windows();
    if !made {
        return;
    }
    match label {
        BAR_LABEL | POPOVER_LABEL | super::dock::DOCK_LABEL => {
            let decided = focus::decide(focus::foreground(), &ours, before.as_ref(), focus::live);
            let landed = decided.is_ok_and(focus::hand_back);
            let first = shared
                .focus
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .count(decided, landed);
            // Each outcome once, so a bar that is clicked all day doesn't fill nook.log.
            if let Some(outcome) = first {
                diag::write(&shared.dir, &Event::BarFocus { outcome: &outcome });
            }
        }
        crate::hearth::window::MAIN => {
            look::pip(app, |p| (p.seen(), None));
            popover(&shared, false);
        }
        _ => popover(&shared, false),
    }
}
