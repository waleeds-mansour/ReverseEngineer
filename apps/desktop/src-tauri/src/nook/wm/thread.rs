// nook-wm's loop (docs/nook-wm.md, "THREADS IN hearth.exe" and "FLUSH"). It waits, with no
// timeout, for its high-resolution timer, its command event, the perf script's export event, or a
// message, which is how the WinEvent callbacks arrive. Then it dispatches messages (the callbacks
// fill the coalescer), runs commands at once, flushes on the leading edge or arms the timer for
// the trailing one, and publishes the state the same way at 100 ms. With nothing happening it
// doesn't wake at all.

use super::super::coalesce::{self, Batch, Plan, CAPACITY};
use super::super::focus::Tally;
use super::super::hooks::{self, HookSet, PIPE, TIMES};
use super::super::perf::{self, Counters, Histogram};
use super::super::probe::{Hwnd, Own, Probe};
use super::super::sync::{self, Handle, Timer, Woke};
use super::super::vd::Vd;
use super::super::view::NookState;
use super::state::Wm;
use super::{fixtures, views, Cmd, Inbox};
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The shortest time between two published states.
pub const PUBLISH_GAP: Duration = Duration::from_millis(100);

pub struct Config {
    pub dir: PathBuf,
    pub own: Own,
    pub observe: bool,
    pub panel_open: bool,
    /// The bar is on: follow the foreground app with F1 from the start.
    pub follow_foreground: bool,
    /// The bar's and popover's windows, when they exist.
    pub chrome: Vec<Hwnd>,
    /// Local\Nook.Diag.<session>, set by the perf script to ask for diag.json.
    pub export_event: Option<Handle>,
    pub counters: Arc<Counters>,
    /// The other Nook threads' counters, for the export.
    pub others: Vec<(&'static str, Arc<Counters>)>,
    pub vd: Option<Arc<Vd>>,
    /// The bar's hand-backs of the foreground, counted apart from the seam's writes.
    pub focus: Arc<Mutex<Tally>>,
    /// Hands each new state to the pages. It must not block.
    pub publish: Box<dyn Fn(&NookState) + Send>,
}

struct Loop {
    batch: Batch,
    last_flush: Option<Instant>,
    flush_at: Option<Instant>,
    last_publish: Option<Instant>,
    publish_at: Option<Instant>,
    armed_for: Option<Instant>,
    seq: u64,
    flush_times: Histogram,
    started: Instant,
}

/// nook-wm's body. It returns when told to stop, or when its channel closes; returning for any
/// other reason (its timer or its wait failing, WM_QUIT) is a fault to observe.rs.
pub fn run<P: Probe>(probe: P, inbox: Inbox, cfg: Config) {
    let _here = cfg.counters.here();
    let started = Instant::now();
    let mut wm = Wm::new(probe, cfg.own, cfg.dir.clone(), started);
    wm.observe_setting = cfg.observe;
    wm.follow_foreground = cfg.follow_foreground;
    wm.chrome = cfg.chrome.clone();
    // Wm::new read the foreground before it knew the bar's and popover's own windows.
    if wm.focused.is_some_and(|h| wm.chrome.contains(&h)) {
        wm.focused = None;
    }
    let mut hooks = HookSet::default();
    hooks.start();
    let Ok(mut timer) = Timer::new() else {
        log::warn!("Nook couldn't make its timer, so it doesn't observe");
        return;
    };
    let mut lp = Loop {
        batch: Batch {
            windows: Vec::with_capacity(CAPACITY),
            ..Batch::default()
        },
        last_flush: None,
        flush_at: None,
        last_publish: None,
        publish_at: None,
        armed_for: None,
        seq: 0,
        flush_times: Histogram::default(),
        started,
    };
    if cfg.panel_open {
        wm.set_panel(true);
    }
    after_change(&mut wm, &mut hooks);
    publish(&mut wm, &mut lp, &cfg, started);

    let mut handles = vec![timer.raw(), inbox.wake.raw()];
    if let Some(e) = &cfg.export_event {
        handles.push(e.raw());
    }
    'run: loop {
        let woke = sync::wait(&handles, None);
        Counters::bump(&cfg.counters.wakeups);
        if woke == Woke::Failed {
            log::warn!("Nook's wait failed, so it stops observing");
            break;
        }
        if !sync::pump() {
            log::warn!("Nook's thread was sent WM_QUIT, so it stops observing");
            break;
        }
        if hooks::take_fault() {
            panic!("a WinEvent callback panicked");
        }
        loop {
            match inbox.rx.try_recv() {
                Ok(Cmd::Stop) | Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'run,
                Ok(cmd) => {
                    Counters::bump(&cfg.counters.commands);
                    command(cmd, &mut wm, &mut lp, &cfg, &hooks);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => break,
            }
        }
        if woke == Woke::Handle(2) {
            let _ = export(&wm, &lp, &cfg, &hooks);
        }
        let now = Instant::now();
        let pending = PIPE.with(|p| p.borrow().pending);
        match coalesce::plan(pending, now, lp.last_flush) {
            Plan::FlushNow => flush(&mut wm, &mut lp, &cfg, now),
            Plan::FlushIn(d) => lp.flush_at = Some(now + d),
            Plan::Idle => {}
        }
        wm.tick(now);
        if let Some(vd) = &cfg.vd {
            let asked = wm.take_vd_questions(now);
            if !asked.is_empty() {
                vd.ask(asked);
            }
        }
        after_change(&mut wm, &mut hooks);
        if wm.changed {
            match lp.last_publish {
                Some(t) if now < t + PUBLISH_GAP => {
                    lp.publish_at.get_or_insert(t + PUBLISH_GAP);
                }
                _ => publish(&mut wm, &mut lp, &cfg, now),
            }
        }
        if lp.publish_at.is_some_and(|t| now >= t) {
            publish(&mut wm, &mut lp, &cfg, now);
        }
        arm(&mut timer, &mut lp, wm.due(), now);
    }
    timer.cancel();
    hooks.clear();
}

fn flush<P: Probe>(wm: &mut Wm<P>, lp: &mut Loop, cfg: &Config, now: Instant) {
    PIPE.with(|p| {
        let mut p = p.borrow_mut();
        p.drain_into(&mut lp.batch);
        cfg.counters.events_in.store(p.events_in, Ordering::Relaxed);
        cfg.counters.coalesced.store(p.coalesced, Ordering::Relaxed);
        cfg.counters.dropped.store(p.dropped, Ordering::Relaxed);
    });
    let start = Instant::now();
    wm.apply(&lp.batch, now);
    lp.flush_times.add(start.elapsed());
    lp.last_flush = Some(now);
    lp.flush_at = None;
    Counters::bump(&cfg.counters.flushes);
}

/// Keeps the callback's list of known windows and the hooks in step with the state.
fn after_change<P: Probe>(wm: &mut Wm<P>, hooks: &mut HookSet) {
    let (added, removed) = wm.take_known();
    if !added.is_empty() || !removed.is_empty() {
        PIPE.with(|p| {
            let mut p = p.borrow_mut();
            added.into_iter().for_each(|h| p.know(h));
            removed.into_iter().for_each(|h| p.forget(h));
        });
    }
    hooks.panel(wm.panel_open);
    hooks.follow(wm.follow_pid());
}

fn command<P: Probe>(cmd: Cmd, wm: &mut Wm<P>, lp: &mut Loop, cfg: &Config, hooks: &HookSet) {
    match cmd {
        Cmd::Stop => {}
        Cmd::Panel(open) => wm.set_panel(open),
        Cmd::Observe(on) => {
            wm.observe_setting = on;
            wm.changed = true;
        }
        Cmd::Refresh => wm.enumerate(),
        Cmd::FollowForeground(on) => wm.follow_foreground = on,
        Cmd::Chrome(ours) => wm.chrome = ours,
        Cmd::SaveFixtures(reply) => {
            let _ = reply.send(fixtures::save(wm));
        }
        Cmd::ExportDiag(reply) => {
            let saved = export(wm, lp, cfg, hooks);
            if let Some(reply) = reply {
                let _ = reply.send(saved);
            }
        }
        Cmd::Shell(signal) => wm.shell(signal, Instant::now()),
        Cmd::Vd(answers) => wm.vd_answers(answers),
    }
}

fn publish<P: Probe>(wm: &mut Wm<P>, lp: &mut Loop, cfg: &Config, now: Instant) {
    lp.seq += 1;
    let state = views::state(wm, now, lp.seq);
    (cfg.publish)(&state);
    wm.changed = false;
    lp.last_publish = Some(now);
    lp.publish_at = None;
}

/// Arms the timer for the earliest thing due, or cancels it when nothing is. Everything due by
/// `now` was handled in this turn, so only later times count: a deadline that somehow stayed in
/// the past must never turn into a timer that fires at once, over and over.
fn arm(timer: &mut Timer, lp: &mut Loop, wm_due: Option<Instant>, now: Instant) {
    let next = [lp.flush_at, lp.publish_at, wm_due]
        .into_iter()
        .flatten()
        .filter(|&t| t > now)
        .min();
    if next == lp.armed_for {
        return;
    }
    match next {
        Some(t) => timer.arm(t.saturating_duration_since(now)),
        None => timer.cancel(),
    }
    lp.armed_for = next;
}

fn export<P: Probe>(
    wm: &Wm<P>,
    lp: &Loop,
    cfg: &Config,
    hooks: &HookSet,
) -> Result<PathBuf, String> {
    let mut threads = serde_json::Map::new();
    threads.insert("nook-wm".into(), json!(cfg.counters.snapshot()));
    for (name, c) in &cfg.others {
        threads.insert((*name).into(), json!(c.snapshot()));
    }
    let callbacks = TIMES.with(|t| t.borrow().summary());
    let focus = cfg.focus.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let value = json!({
        "version": 1,
        "at": nook_restore::log::stamp(nook_restore::clock::now_ms()),
        "uptime_ms": lp.started.elapsed().as_millis() as u64,
        "mode": "observing",
        "panel_open": wm.panel_open,
        "threads": threads,
        "callback": callbacks,
        "flush": lp.flush_times.summary(),
        "hooks": hooks.count(),
        "hooks_refused": hooks.refused,
        "followed_pid": hooks.followed(),
        "writes": wm.writer.counts(),
        "focus_restores": focus.focus_restores,
        "focus_failed": focus.focus_failed,
        "focus_refused": focus.focus_refused,
        "windows_cached": wm.windows.len(),
        "stats": wm.stats,
        "gates": wm.gates.names(Instant::now()),
        "published": lp.seq,
        "dpi_per_monitor_v2": per_monitor_v2(),
    });
    perf::write_export(&wm.dir, &value).map_err(|e| e.to_string())
}

/// Whether this thread is per-monitor-v2 DPI aware, as tao makes Hearth's process.
fn per_monitor_v2() -> bool {
    use windows::Win32::UI::HiDpi::{
        AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    unsafe {
        AreDpiAwarenessContextsEqual(
            GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        )
    }
    .as_bool()
}
