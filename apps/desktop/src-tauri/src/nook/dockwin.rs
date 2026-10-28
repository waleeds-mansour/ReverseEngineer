// The agent dock's window, made, shown and destroyed as dock.rs decides, with the bar's machinery
// (barwin.rs): the same builder and own style, made hidden on a blocking thread, one sync at a
// time under the bar's sync lock, and everything done to the window on the main thread, in order.
// Its page says when it has drawn (the readiness handshake); one that doesn't within DRAW_WITHIN
// is made again, once. While the dock is made it reads Windows every LOOK_EVERY: whether something
// fullscreen is in front, where the primary monitor is, and Windows' text size, which WebView2
// draws the page at, and it ends a rest from its menu once the hour is up. While its pill is open
// it reads where the pointer is every WATCH_EVERY, and closes the pill once the pointer has left.
// After every change to the window its region is set again (dockclip.rs), so it takes clicks only
// on what its page draws: the tab, and while open the pill and the label where the page says.
// With its switch off, none of this starts a thread. What the owner does to the dock itself, its
// menu, dragging it, its sounds and its pill's buttons, is dockact.rs.

use super::bar::Place;
use super::barwin;
use super::dock::{self, DockRun, DockStep, DOCK_LABEL, DOCK_PAGE};
use super::dockclip::LabelBox;
use super::docksize::{rest_long, DOCK_DEEP};
use super::host::{self, Shared};
use super::probe::{Hwnd, Rect};
use super::view::NookState;
use super::{look, observe, surface, ui};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use windows::Win32::Foundation::POINT;
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTOPRIMARY,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

/// How long the dock's page has to draw its first frame before its window is made again, once.
const DRAW_WITHIN: Duration = Duration::from_secs(3);
/// How often the dock reads Windows while it is made.
const LOOK_EVERY: Duration = Duration::from_secs(2);
/// How often the pointer is read while the pill is open.
const WATCH_EVERY: Duration = Duration::from_millis(150);
/// Each making of the window, so a late check or reading for one never acts on the next.
static MAKES: AtomicU64 = AtomicU64::new(0);
/// Each opening of the pill, so only the latest one's watch goes on.
static OPENS: AtomicU64 = AtomicU64::new(0);

/// Brings the dock to what its switch and Nook's status say.
pub fn sync(shared: &Arc<Shared>) {
    let idle = {
        let mut run = shared.dock();
        if !run.setting {
            run.why_not = None;
        }
        !run.setting && !run.made
    };
    if idle {
        return;
    }
    let s = shared.clone();
    tauri::async_runtime::spawn_blocking(move || sync_now(&s));
}

fn sync_now(shared: &Arc<Shared>) {
    let _one = shared.bar_sync.lock().unwrap_or_else(|p| p.into_inner());
    let (want, made) = {
        let mut run = shared.dock();
        let want = dock::wanted(run.setting, shared.status());
        // A dock given up on (DockRun::undrawn) keeps saying why, until its page draws after all.
        let given_up = run.remade && run.made && !run.drawn;
        run.why_not = want.err().or(if given_up { run.why_not } else { None });
        (want, run.made)
    };
    match (want, made) {
        (Ok(()), false) => match make(shared) {
            Ok(ours) => {
                let made = MAKES.fetch_add(1, Ordering::SeqCst) + 1;
                let (busy, monitor) = (busy_now(), primary());
                {
                    let mut run = shared.dock();
                    run.made = true;
                    run.ours = ours;
                    run.read(busy, monitor);
                    run.text = text_now();
                }
                barwin::tell_own(shared);
                must_draw(shared, made);
                keep_looking(shared, made);
                log::info!("Nook's agent dock is on");
                // The theme and motion settings, as the bar reads them when it is made.
                look::read_system(shared);
                // nook-wm may already be observing for the bar or the panel.
                let state = observe::current(shared, &shared.observer());
                on_state(shared, &state);
            }
            Err(e) => {
                log::warn!("Couldn't make Nook's agent dock: {e}");
                destroy(&shared.app);
                shared.dock().why_not = Some("The dock's window didn't open; nook.log says more");
            }
        },
        (Err(why), true) => {
            destroy(&shared.app);
            {
                let mut run = shared.dock();
                *run = DockRun {
                    why_not: run.why_not,
                    ..run.kept()
                };
            }
            barwin::tell_own(shared);
            log::info!("Nook's agent dock is off: {why}");
        }
        _ => {}
    }
    look::emit(shared);
}

/// A dock whose page never says it drew would stay hidden for good: after DRAW_WITHIN its window
/// is made again, and if that one doesn't draw either it is left hidden, saying why.
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
        let Some(again) = shared.dock().undrawn() else {
            return;
        };
        log::warn!(
            "Nook's agent dock didn't draw within {} s; {}",
            DRAW_WITHIN.as_secs(),
            if again {
                "making it again"
            } else {
                "it stays hidden"
            }
        );
        if again {
            destroy(&shared.app);
            barwin::tell_own(shared);
        }
        again
    };
    if again {
        sync_now(shared);
    } else {
        look::emit(shared);
    }
}

/// While this making of the window lasts, reads Windows every LOOK_EVERY.
fn keep_looking(shared: &Arc<Shared>, made: u64) {
    let s = shared.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(LOOK_EVERY).await;
            if MAKES.load(Ordering::SeqCst) != made {
                return;
            }
            let (busy, monitor, text) = (busy_now(), primary(), text_now());
            let moved = {
                let mut run = s.dock();
                if !run.made {
                    return;
                }
                let before = run.seen();
                run.read(busy, monitor);
                run.text = text;
                run.wake(Instant::now());
                before != run.seen()
            };
            if moved {
                nudge(&s.app);
                look::emit(&s);
            }
        }
    });
}

/// Windows' notification state: something fullscreen, a presentation, or nobody there.
fn busy_now() -> bool {
    match unsafe { SHQueryUserNotificationState() } {
        Ok(state) => dock::busy(state.0),
        Err(_) => false,
    }
}

/// Windows' text size (Settings > Accessibility > Text size), which it keeps as TextScaleFactor
/// only while it is above 100 %. The bar reads it too (barwin.rs).
pub(super) fn text_now() -> u32 {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let raw = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Accessibility")
        .and_then(|k| k.get_value::<u32, _>("TextScaleFactor"))
        .ok();
    dock::text_size(raw)
}

/// Where the pointer is, in physical px.
pub(super) fn cursor() -> Option<(i32, i32)> {
    let mut p = POINT::default();
    unsafe { GetCursorPos(&mut p) }.ok()?;
    Some((p.x, p.y))
}

/// The primary monitor, which always holds the point (0, 0), and its work area, in physical px.
fn primary() -> Option<(Place, Rect)> {
    let h = unsafe { MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY) };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(h, &mut info) }.as_bool() {
        return None;
    }
    let (mut dx, mut dy) = (96u32, 96u32);
    let _ = unsafe { GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    let rect = |r: windows::Win32::Foundation::RECT| Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    };
    let at = Place {
        rect: rect(info.rcMonitor),
        dpi: dx,
    };
    Some((at, rect(info.rcWork)))
}

/// The dock's window, hidden, and its handle: topmost, never activated, with no glass of its
/// own (its page draws the tab).
fn make(shared: &Shared) -> Result<Vec<Hwnd>, String> {
    let at = primary().map(|(at, _)| at);
    let (x, y) = at.map_or((0.0, 0.0), |p| {
        let s = f64::from(p.dpi.max(1)) / 96.0;
        (f64::from(p.rect.left) / s, f64::from(p.rect.top) / s)
    });
    let w = barwin::builder(&shared.app, DOCK_LABEL, DOCK_PAGE)
        .title("Nook dock")
        .always_on_top(true)
        .position(x, y)
        .inner_size(f64::from(DOCK_DEEP), f64::from(rest_long(1)))
        .build()
        .map_err(|e| e.to_string())?;
    let ours = w.hwnd().ok().map(|h| h.0 as Hwnd).into_iter().collect();
    let _ = shared
        .app
        .run_on_main_thread(move || surface::own_style(&w));
    Ok(ours)
}

fn destroy(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(DOCK_LABEL) {
        if let Err(e) = w.destroy() {
            log::warn!("Couldn't close Nook's agent dock: {e}");
        }
    }
}

/// A new state from nook-wm, or Nook stopping. Called with no lock but the observer's held.
pub fn on_state(shared: &Shared, state: &NookState) {
    let moved = {
        let mut run = shared.dock();
        if !run.made {
            return;
        }
        let before = run.seen();
        run.take(state);
        before != run.seen()
    };
    if moved {
        nudge(&shared.app);
        look::emit(shared);
    }
}

/// The dock's page drew its first frame: the other half of the readiness handshake.
pub fn drawn(shared: &Shared) {
    shared.dock().drawn = true;
    nudge(&shared.app);
}

/// The pointer came over the dock, or left it. While the pill is open, the pointer is watched.
pub fn hover(shared: &Arc<Shared>, open: bool) {
    let (changed, opened) = {
        let mut run = shared.dock();
        let was = run.open;
        run.hover(open);
        (was != run.open, run.open && !was)
    };
    if opened {
        watch_pointer(shared);
    }
    if changed {
        nudge(&shared.app);
        look::emit(shared);
    }
}

/// Every WATCH_EVERY while this opening of the pill lasts: once the pointer has left the window,
/// the pill closes and the window narrows, and the page hears it in the chrome's dock.open.
fn watch_pointer(shared: &Arc<Shared>) {
    let open = OPENS.fetch_add(1, Ordering::SeqCst) + 1;
    let s = shared.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            if OPENS.load(Ordering::SeqCst) != open {
                return;
            }
            let at = cursor();
            let closed = {
                let mut run = s.dock();
                if !run.open {
                    return;
                }
                run.pointer(at)
            };
            if closed {
                nudge(&s.app);
                look::emit(&s);
                return;
            }
        }
    });
}

/// How many dots Nook's chrome shows now, and whether anything waits: the tab grows or shrinks to
/// fit them, and its region takes in the count badge while it shows.
pub fn dots(shared: &Shared, n: usize, waiting: bool) {
    let changed = {
        let mut run = shared.dock();
        let was = (run.dots, run.waiting);
        (run.dots, run.waiting) = (n, waiting);
        run.made && was != (n, waiting)
    };
    if changed {
        nudge(&shared.app);
    }
}

/// Where the open pill's status label is now, as its page says, so the window's region takes it
/// in while the pill is open.
pub fn label(shared: &Shared, top: i32, bottom: i32, wide: i32) {
    let changed = {
        let mut run = shared.dock();
        let was = run.label;
        run.label = LabelBox::read(top, bottom, wide);
        run.made && was != run.label
    };
    if changed {
        nudge(&shared.app);
    }
}

/// Carries out dock.rs's plan on the main thread. Never call it holding the dock's lock: on the
/// main thread it runs at once.
pub fn nudge(app: &AppHandle) {
    let a = app.clone();
    let _ = app.run_on_main_thread(move || reconcile(&a));
}

fn reconcile(app: &AppHandle) {
    let Some(shared) = host::shared(app) else {
        return;
    };
    let (steps, clip) = {
        let mut run = shared.dock();
        (run.plan(), run.clip())
    };
    let Some(w) = app.get_webview_window(DOCK_LABEL) else {
        return;
    };
    for step in steps {
        match step {
            DockStep::Place(r) => surface::place(&w, r),
            DockStep::Wake => {
                surface::wake(&w);
                ui::send_latest(&shared, DOCK_LABEL);
            }
            DockStep::Show => surface::show_topmost(&w),
            DockStep::Hide => surface::hide(&w),
            DockStep::Sleep => surface::sleep(&w),
        }
    }
    if let Some(shapes) = clip {
        surface::clip(&w, &shapes);
    }
}
