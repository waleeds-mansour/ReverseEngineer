// The agent dock's window, made, shown and destroyed as dock.rs decides, with the bar's machinery
// (barwin.rs): the same builder and own style, made hidden on a blocking thread, one sync at a
// time under the bar's sync lock, and everything done to the window on the main thread, in order.
// Its page says when it has drawn (the readiness handshake); one that doesn't within DRAW_WITHIN
// is made again, once. While the dock is made it reads Windows every LOOK_EVERY: whether something
// fullscreen is in front, where the primary monitor is, and Windows' text size, which WebView2
// draws the page at, and it ends a rest from its menu once the hour is up (dockread.rs). While
// the notch is open and no panel holds it, it reads where the pointer is every WATCH_EVERY, and
// folds the notch once the pointer has stayed off it for AWAY_READS reads, a little after the
// page's own 350 ms; a page that doesn't answer that with its shape within ANSWER_WITHIN is taken
// for dead, and the region falls back to the tab's own piece. A page whose process fails is made
// again with its window. The window is made once, at its biggest (docksize.rs), its page zoomed to
// the owner's size; after every change its region is set again (dockclip.rs), so it takes clicks
// only on what its page draws: the tab, and the outlines the page says it draws. With its switch
// off, none of this starts a thread. What the owner does to the dock itself is dockact.rs.

use super::barwin;
use super::dock::{self, DockRun, DockStep, DOCK_LABEL, DOCK_PAGE};
use super::dockread::{busy_now, primary};
use super::docksize::{tab_long, WINDOW_DEEP};
use super::host::{self, Shared};
use super::probe::Hwnd;
use super::view::NookState;
use super::{look, observe, surface, ui};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub(super) use super::dockread::{cursor, text_now};

/// How long the dock's page has to draw its first frame before its window is made again, once.
const DRAW_WITHIN: Duration = Duration::from_secs(3);
/// How often the dock reads Windows while it is made.
const LOOK_EVERY: Duration = Duration::from_secs(2);
/// How often the pointer is read while the notch is open.
const WATCH_EVERY: Duration = Duration::from_millis(150);
/// Reads in a row the pointer is off the notch before Nook folds it: the page folds it 350 ms
/// after the pointer leaves, and this only catches a page that didn't hear it go.
const AWAY_READS: u32 = 3;
/// How long a page has to answer Nook folding its notch with its shape.
const ANSWER_WITHIN: Duration = Duration::from_secs(1);
/// Each making of the window, so a late check or reading for one never acts on the next.
static MAKES: AtomicU64 = AtomicU64::new(0);
/// Each opening of the notch, so only the latest one's watch goes on.
static OPENS: AtomicU64 = AtomicU64::new(0);
/// Each shape the page tells, so a fold it never answered is seen.
static SHAPES: AtomicU64 = AtomicU64::new(0);

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
                if let Some(w) = shared.app.get_webview_window(DOCK_LABEL) {
                    let s = shared.clone();
                    surface::on_failed(&w, move || {
                        let s = s.clone();
                        tauri::async_runtime::spawn_blocking(move || failed(&s, made));
                    });
                }
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

/// Its page's process failed: a renderer that crashed or hung leaves a dead page holding its last
/// region, which can be a panel's size of the screen taking clicks. The window is made again.
fn failed(shared: &Arc<Shared>, made: u64) {
    {
        let _one = shared.bar_sync.lock().unwrap_or_else(|p| p.into_inner());
        if MAKES.load(Ordering::SeqCst) != made {
            return;
        }
        log::warn!("The page of Nook's agent dock failed; making it again");
        destroy(&shared.app);
        {
            let mut run = shared.dock();
            *run = DockRun {
                why_not: run.why_not,
                ..run.kept()
            };
        }
        barwin::tell_own(shared);
    }
    sync_now(shared);
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
        .inner_size(f64::from(WINDOW_DEEP), f64::from(tab_long(1)))
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

/// What the page says of the notch (DockRun::shape). While it is open and nothing holds it, the
/// pointer is watched.
pub fn shape(shared: &Arc<Shared>, open: bool, hold: bool, outlines: Vec<Vec<(f64, f64)>>) {
    SHAPES.fetch_add(1, Ordering::SeqCst);
    let (changed, watch) = {
        let mut run = shared.dock();
        let was = (run.open, run.hold);
        let opened = run.shape(open, hold, outlines);
        let watch = opened || (was.1 && !run.hold && run.open);
        (was != (run.open, run.hold), watch)
    };
    if watch {
        watch_pointer(shared);
    }
    // The region follows the outlines whether or not anything else changed.
    nudge(&shared.app);
    if changed {
        look::emit(shared);
    }
}

/// Every WATCH_EVERY while this opening of the notch lasts and nothing holds it: once the pointer
/// has been off what the region covers for AWAY_READS reads, the notch folds, and the page hears
/// it in the chrome's dock.open.
fn watch_pointer(shared: &Arc<Shared>) {
    let open = OPENS.fetch_add(1, Ordering::SeqCst) + 1;
    let s = shared.clone();
    tauri::async_runtime::spawn(async move {
        let mut away = 0;
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            if OPENS.load(Ordering::SeqCst) != open {
                return;
            }
            let at = cursor();
            let closed = {
                let mut run = s.dock();
                if !run.open || run.hold {
                    return;
                }
                away = if run.covers(at) { 0 } else { away + 1 };
                away >= AWAY_READS && run.pointer(at)
            };
            if closed {
                nudge(&s.app);
                look::emit(&s);
                unanswered(&s);
                return;
            }
        }
    });
}

/// Nook folded the notch: a page that doesn't answer with its shape within ANSWER_WITHIN is dead
/// or stuck, so the region keeps only the tab's own piece rather than the open notch's outlines.
fn unanswered(shared: &Arc<Shared>) {
    let told = SHAPES.load(Ordering::SeqCst);
    let s = shared.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ANSWER_WITHIN).await;
        if SHAPES.load(Ordering::SeqCst) != told {
            return;
        }
        let cleared = {
            let mut run = s.dock();
            let stale = !run.open && !run.outlines.is_empty();
            if stale {
                run.outlines.clear();
            }
            stale
        };
        if cleared {
            log::warn!("The agent dock's page didn't answer its notch folding; keeping the tab");
            nudge(&s.app);
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
            DockStep::Zoom(percent) => surface::zoom(&w, percent),
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
