// When Nook observes (docs/nook-wm.md, "OPT-IN FLOW", step 2), and its three threads while it
// does: nook-wm, nook-shell and nook-com. Observing writes nothing: hooks, verdicts and gates
// only, with every write refused. It runs while the panel is open, or all the time when the owner
// turns on the observing switch, which starts off. Nothing runs otherwise: no hook, no window, no
// thread, as P0 promised for a Nook that is off. The bar observes too, while it is on, so it can
// hide over games. The disabled file stops observing; safe start stops the switch and the bar but
// not the panel, which the owner opens on purpose and which writes nothing. A panic in any of the
// threads stops all three, and the bar, until Hearth starts again, and so does one of them ending
// when it wasn't asked to, as when its timer, its wait or its window fails.

use super::host::{self, Shared};
use super::perf::{self, Counters};
use super::probe::Own;
use super::shell::Shell;
use super::start::Status;
use super::vd::Vd;
use super::view::{ModeName, NookState};
use super::wm::{self, Cmd, Link};
use super::{diag, process, sync, ui, window};
use nook_restore::objects::session::session_tag;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

/// How long stopping waits for the three threads.
const STOP_WAIT: Duration = Duration::from_secs(1);
const THREADS: usize = 3;
/// What one of the three threads runs.
type Body = Box<dyn FnOnce() + Send>;

#[derive(Default)]
pub struct Observer {
    running: Option<Running>,
    pub panel_open: bool,
    pub setting: bool,
    /// The bar is on, and needs to know what's in front.
    pub bar: bool,
    /// A thread panicked or ended unasked; observing stays off until Hearth starts again.
    pub faulted: bool,
    /// The last of the panel's opens and closes applied (host::panel).
    panel_turn: u64,
}

struct Running {
    link: Link,
    shell: Arc<Shell>,
    vd: Arc<Vd>,
    done: mpsc::Receiver<&'static str>,
    /// Set before the threads are told to stop, so one that ends otherwise is a fault.
    asked: Arc<AtomicBool>,
}

/// Whether to observe now, or why not.
pub fn wanted(o: &Observer, status: Status) -> Result<(), &'static str> {
    if o.faulted {
        return Err("Observing stopped after a problem in Nook; nook.log says more");
    }
    if status == Status::Disabled {
        return Err("Nook is turned off by the disabled file in its folder");
    }
    if !o.panel_open && !o.setting && !o.bar {
        return Err("Observing is off");
    }
    if !o.panel_open && status == Status::SafeStart {
        return Err("Safe start: Nook stopped unexpectedly twice, so it observes only while this panel is open");
    }
    Ok(())
}

impl Observer {
    pub fn new(setting: bool) -> Observer {
        Observer {
            setting,
            ..Observer::default()
        }
    }

    pub fn link(&self) -> Option<&Link> {
        self.running.as_ref().map(|r| &r.link)
    }

    pub fn running(&self) -> bool {
        self.running.is_some()
    }

    /// The panel opened or closed, as its `turn`th open or close. False, changing nothing, for a
    /// turn older than one already applied, since workers can reach the lock out of order.
    pub fn panel_turn(&mut self, turn: u64, open: bool) -> bool {
        if turn <= self.panel_turn {
            return false;
        }
        self.panel_turn = turn;
        self.panel_open = open;
        true
    }
}

/// Starts or stops the threads to match the switch, the panel and Nook's status.
pub fn sync_with(shared: &Arc<Shared>, o: &mut Observer) {
    match (wanted(o, shared.status()), o.running.is_some()) {
        (Ok(()), false) => {
            if !start(shared, o) {
                stop(o, "a thread didn't start", shared);
                publish_off(shared, o, DIDNT_START);
            }
        }
        (Err(why), true) => {
            stop(o, why, shared);
            publish_off(shared, o, why);
        }
        (Err(why), false) => publish_off(shared, o, why),
        (Ok(()), true) => {}
    }
}

const DIDNT_START: &str = "Observing didn't start; nook.log says more";

/// Hearth is quitting.
pub fn shut(shared: &Shared, o: &mut Observer) {
    stop(o, "Hearth is quitting", shared);
}

/// What a page that has just opened should show.
pub fn current(shared: &Shared, o: &Observer) -> NookState {
    match wanted(o, shared.status()) {
        Ok(()) if o.running() => shared
            .snapshot
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone(),
        Ok(()) => off_state(o, DIDNT_START),
        Err(why) => off_state(o, why),
    }
}

/// False when a thread couldn't be started; the ones that did are stopped by the caller.
fn start(shared: &Arc<Shared>, o: &mut Observer) -> bool {
    let Ok((link, inbox)) = wm::channel() else {
        return false;
    };
    let (Ok(vd), shell) = (Vd::new(), Arc::new(Shell::default())) else {
        return false;
    };
    let (done_tx, done) = mpsc::channel();
    let asked = Arc::new(AtomicBool::new(false));
    let wm_counters = Arc::new(Counters::default());
    let app = shared.app.clone();
    let snapshot = shared.snapshot.clone();
    let cfg = wm::thread::Config {
        dir: shared.dir.clone(),
        own: Own {
            pid: std::process::id(),
            elevated: process::own_elevated(),
        },
        observe: o.setting,
        panel_open: o.panel_open,
        follow_foreground: o.bar,
        // The observer's lock may be held while the bar's is taken.
        chrome: shared.bar().ours.clone(),
        export_event: match sync::own_event(&perf::export_event_name(&session_tag())) {
            Ok(e) => Some(e),
            Err(e) => {
                log::warn!("Nook's diag export can't be asked for this time: {e}");
                None
            }
        },
        counters: wm_counters,
        others: vec![
            ("nook-shell", shell.counters.clone()),
            ("nook-com", vd.counters.clone()),
        ],
        vd: Some(vd.clone()),
        focus: shared.focus.clone(),
        publish: Box::new(move |state: &NookState| {
            *snapshot.lock().unwrap_or_else(|p| p.into_inner()) = state.clone();
            ui::emit(&app, state);
        }),
    };
    let to_wm = link.clone();
    let theme_app = shared.app.clone();
    let shell_body = shell.clone();
    let to_wm_vd = link.clone();
    let vd_body = vd.clone();
    let bodies: [(&'static str, Body); THREADS] = [
        (
            "wm",
            Box::new(move || wm::thread::run(window::RealProbe, inbox, cfg)),
        ),
        (
            "shell",
            Box::new(move || {
                let tell = move |s| {
                    // Light or dark, transparency or high contrast: the bar's look follows.
                    if s == super::shell::Signal::Theme {
                        super::look::system_changed(&theme_app);
                    }
                    to_wm.send(Cmd::Shell(s));
                };
                if let Err(e) = super::shell::run(shell_body, tell) {
                    log::warn!("Nook's shell window didn't start: {e}");
                }
            }),
        ),
        (
            "com",
            Box::new(move || {
                super::vd::run(vd_body, move |a| {
                    to_wm_vd.send(Cmd::Vd(a));
                })
            }),
        ),
    ];
    let mut all = true;
    for (name, body) in bodies {
        let tx = done_tx.clone();
        let after = shared.clone();
        let ended = shared.clone();
        let stopping = asked.clone();
        let tx_unwound = done_tx.clone();
        all &= host::spawn_long(
            shared,
            name,
            move || {
                body();
                let _ = tx.send(name);
                if !stopping.load(Ordering::SeqCst) {
                    quit(&ended, name);
                }
            },
            move |thread| {
                let _ = tx_unwound.send(name);
                faulted(&after, thread);
            },
        );
    }
    o.running = Some(Running {
        link,
        shell,
        vd,
        done,
        asked,
    });
    if !all {
        return false;
    }
    diag::write(
        &shared.dir,
        &diag::Event::Observing {
            on: true,
            why: if o.panel_open {
                "the panel is open"
            } else if o.setting {
                "the observing switch is on"
            } else {
                "the bar is on"
            },
        },
    );
    true
}

/// Tells the threads to stop and waits a moment for them. A thread that doesn't stop in time is
/// left to finish on its own; it writes nothing either way.
fn stop(o: &mut Observer, why: &str, shared: &Shared) {
    let Some(r) = o.running.take() else {
        return;
    };
    r.asked.store(true, Ordering::SeqCst);
    r.link.send(Cmd::Stop);
    r.shell.stop();
    r.vd.stop();
    let deadline = Instant::now() + STOP_WAIT;
    let mut ended = 0;
    while ended < THREADS {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() || r.done.recv_timeout(left).is_err() {
            break;
        }
        ended += 1;
    }
    if ended < THREADS {
        log::warn!(
            "{} of Nook's observing threads didn't stop within a second",
            THREADS - ended
        );
    }
    diag::write(&shared.dir, &diag::Event::Observing { on: false, why });
}

/// Only Nook's open windows need the state; with none open this reads nothing.
fn publish_off(shared: &Shared, o: &Observer, why: &str) {
    if !ui::any_open(&shared.app) {
        return;
    }
    let state = off_state(o, why);
    *shared.snapshot.lock().unwrap_or_else(|p| p.into_inner()) = state.clone();
    ui::emit(&shared.app, &state);
}

/// The state while Nook doesn't observe: the monitors, read afresh, and why it's off.
pub fn off_state(o: &Observer, why: &str) -> NookState {
    NookState {
        mode: ModeName::Off,
        why_off: Some(why.to_string()),
        observe: o.setting,
        panel_open: o.panel_open,
        elevated: process::own_elevated(),
        monitors: {
            let list = super::monitors::enumerate();
            let managed: Vec<String> = list
                .iter()
                .filter(|m| m.managed())
                .map(|m| m.id.clone())
                .collect();
            list.iter()
                .map(|m| wm::views::monitor(m, &managed))
                .collect()
        },
        ..NookState::default()
    }
}

/// A thread unwound: the restore runs as for any Nook thread, and observing stops until Hearth
/// starts again.
fn faulted(shared: &Arc<Shared>, thread: &str) {
    host::unwound(shared, thread);
    off_for_good(shared);
}

/// A thread ended unasked: nothing unwound, so there is nothing to restore, but observing stops
/// as after a panic, rather than going on with a thread missing.
fn quit(shared: &Arc<Shared>, thread: &str) {
    log::warn!("Nook's {thread} thread ended without being asked; observing stops");
    diag::write(&shared.dir, &diag::Event::Ended { thread });
    off_for_good(shared);
}

fn off_for_good(shared: &Arc<Shared>) {
    let mut o = shared.observer();
    o.faulted = true;
    sync_with(shared, &mut o);
    drop(o);
    super::barwin::sync(shared);
}
