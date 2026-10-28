// Nook's part of the app on Windows: its folder, its status, the start check, the restore before
// an update, its threads, the observer that the panel, the observing switch or the bar starts,
// and the bar's state. Every restore here is nook-restore's restore_all on the real desktop,
// which is tested in that crate against FakeDesktop and on private desktops; the tests here cover
// only what this file decides on its own. Locks: the observer's may be held while the bar's or
// the dock's is taken, never the other way round; the bar's and the dock's are never held
// together, and Chrome's is never held while another is taken.

use super::bar::BarRun;
use super::diag::{self, By, Event};
use super::dock::DockRun;
use super::focus::Tally;
use super::look::Chrome;
use super::observe::{self, Observer};
use super::probe::Hwnd;
use super::start::{self, Status};
use super::view::NookState;
use super::{barwin, dockwin, settings, unwind};
use nook_restore::journal::Loaded;
use nook_restore::objects::session::{session_tag, SessionObjects};
use nook_restore::objects::Unshared;
use nook_restore::recover::{at_start, Start};
use nook_restore::{restore_all, Context, RealDesktop, Reason, Report, Signals, Store};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// This build's version as CI numbered it (build.rs), so the journal and the restore CLI agree
/// on which Hearth wrote what.
const VERSION: &str = env!("HEARTH_VERSION");
/// How long quitting waits for a restore that is still running.
const QUIT_WAIT: Duration = Duration::from_secs(3);
/// How long the settings window waits for the restore before an update.
const UPDATE_WAIT: Duration = Duration::from_secs(10);

/// Nook in the app, as Tauri state: where its files are, why it is off, and the observer.
pub struct NookHandle(Arc<Shared>);

pub(super) struct Shared {
    pub(super) app: AppHandle,
    pub(super) dir: PathBuf,
    /// A snapshot, replaced whenever something changes it.
    status: Mutex<Status>,
    workers: Arc<unwind::Workers>,
    /// The last state nook-wm published, for a page that has just opened.
    pub(super) snapshot: Arc<Mutex<NookState>>,
    pub(super) observer: Mutex<Observer>,
    bar: Mutex<BarRun>,
    dock: Mutex<DockRun>,
    chrome: Mutex<Chrome>,
    /// One bar or dock sync at a time, so making and destroying their windows never interleave.
    pub(super) bar_sync: Mutex<()>,
    /// The bar's hand-backs of the foreground, for diag.json.
    pub(super) focus: Arc<Mutex<Tally>>,
    /// The panel's opens and closes, numbered as they happen.
    panel_turns: AtomicU64,
}

impl Shared {
    pub(super) fn status(&self) -> Status {
        *self.status.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn observer(&self) -> MutexGuard<'_, Observer> {
        self.observer.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn bar(&self) -> MutexGuard<'_, BarRun> {
        self.bar.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn dock(&self) -> MutexGuard<'_, DockRun> {
        self.dock.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub(super) fn chrome(&self) -> MutexGuard<'_, Chrome> {
        self.chrome.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether the bar's or the dock's window exists, so Nook's chrome has a page to go to.
    pub(super) fn chrome_shown(&self) -> bool {
        self.bar().made || self.dock().made
    }

    /// The bar's, the popover's, the dock's and the quick-ask box's own windows, never to be
    /// taken for the window in front. Takes the bar's lock and then the dock's, one after the other.
    pub(super) fn own_windows(&self) -> Vec<Hwnd> {
        let mut ours = self.bar().ours.clone();
        ours.extend(self.dock().ours.iter().copied());
        ours.extend(crate::hearth::quick_ask::hwnd(&self.app));
        ours
    }

    /// Reads the switches, the disabled file and the journal's unclean ends again.
    fn refresh(&self) {
        let unclean = match Store::in_dir(&self.dir).load() {
            Loaded::Found(journal) => journal.unclean,
            _ => Vec::new(),
        };
        let settings = settings::load(&self.app);
        let status = start::status(&settings, start::disabled(&self.dir), &unclean);
        *self.status.lock().unwrap_or_else(|p| p.into_inner()) = status;
        if settings.any_on() {
            diag::write(&self.dir, &Event::HeldOff { why: status.why() });
        }
    }
}

/// Nook's folder: Data\nook in a portable install, like Hearth's other files there, otherwise
/// the %LOCALAPPDATA%\app.hearth.desktop\nook that the CLI, the guard and the installer use.
fn dir() -> PathBuf {
    match crate::portable::data_dir() {
        Some(data) => data.join("nook"),
        None => nook_restore::cli::default_dir(),
    }
}

/// What starting decides, without the app: Nook's status and whether the start check runs. It
/// is all Nook does when Hearth starts in this version: no hook, hotkey, window or thread comes
/// of it, except the start check's thread when the last run left something owed.
pub(super) struct Plan {
    pub status: Status,
    pub check: bool,
}

pub(super) fn plan(dir: &Path, settings: &settings::NookSettings) -> Plan {
    let (journal, unclean) = match Store::in_dir(dir).load() {
        Loaded::Missing => (start::Journal::Missing, Vec::new()),
        Loaded::Corrupt(_) => (start::Journal::Corrupt, Vec::new()),
        // A journal that reads clean but lists a window an earlier restore couldn't put back
        // still owes, so the start check tries that window again.
        Loaded::Found(j) if !j.owes_restore() => (start::Journal::Clean, j.unclean),
        Loaded::Found(j) => (start::Journal::Dirty, j.unclean),
    };
    Plan {
        status: start::status(settings, start::disabled(dir), &unclean),
        check: start::needs_check(journal),
    }
}

pub fn init(app: &AppHandle) {
    let dir = dir();
    let settings = settings::load(app);
    let plan = plan(&dir, &settings);
    let shared = Arc::new(Shared {
        app: app.clone(),
        dir,
        status: Mutex::new(plan.status),
        workers: Arc::default(),
        snapshot: Arc::default(),
        observer: Mutex::new(Observer::new(settings.observe)),
        bar: Mutex::new(BarRun {
            setting: settings.bar,
            ..BarRun::default()
        }),
        dock: Mutex::new(DockRun {
            place: super::dockplace::load(app),
            ..DockRun::new(settings.dock)
        }),
        chrome: Mutex::new(Chrome::new(settings::load_theme(app))),
        bar_sync: Mutex::new(()),
        focus: Arc::default(),
        panel_turns: AtomicU64::new(0),
    });
    shared.refresh();
    app.manage(NookHandle(shared.clone()));
    if plan.check {
        let s = shared.clone();
        spawn(&shared, "start", move || check_at_start(&s));
    }
    // With the switches off, as they start, these start nothing. The dock's starts on.
    observe::sync_with(&shared, &mut shared.observer());
    barwin::sync(&shared);
    dockwin::sync(&shared);
}

pub(super) fn shared(app: &AppHandle) -> Option<Arc<Shared>> {
    app.try_state::<NookHandle>().map(|h| h.0.clone())
}

/// The panel opened or closed. Opening it starts observing; closing it stops observing unless
/// the switch is on. A close comes on the main thread, and the observer's lock can be held for a
/// second or two while its threads stop, so both run on a worker. Each takes a numbered turn
/// here, and a turn that reaches the lock after a later one is dropped: the last word wins.
pub(super) fn panel(app: &AppHandle, open: bool) {
    let Some(shared) = shared(app) else {
        return;
    };
    let turn = shared.panel_turns.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let mut o = shared.observer();
        if !o.panel_turn(turn, open) {
            return;
        }
        if let Some(link) = o.link() {
            link.send(super::wm::Cmd::Panel(open));
        }
        observe::sync_with(&shared, &mut o);
    });
}

pub fn shutdown(app: &AppHandle) {
    let Some(handle) = app.try_state::<NookHandle>() else {
        return;
    };
    observe::shut(&handle.0, &mut handle.0.observer());
    if !handle.0.workers.wait_idle(QUIT_WAIT) {
        diag::write(&handle.0.dir, &Event::QuitDuringRestore);
    }
}

pub fn arranging(app: &AppHandle) -> bool {
    app.try_state::<NookHandle>()
        .is_some_and(|handle| handle.0.status().arranges())
}

pub async fn prepare_update(app: AppHandle) -> Result<(), String> {
    let Some(shared) = app.try_state::<NookHandle>().map(|h| h.0.clone()) else {
        return Ok(());
    };
    let owes = match Store::in_dir(&shared.dir).load() {
        Loaded::Missing => false,
        Loaded::Corrupt(_) => true,
        Loaded::Found(journal) => journal.owes_restore(),
    };
    if !owes {
        return Ok(());
    }
    let (tx, rx) = mpsc::channel();
    let s = shared.clone();
    spawn(&shared, "update", move || {
        let report = restore(&s.dir, Reason::Update);
        finished(&s, By::Update, &report);
        let _ = tx.send(report.failed.len());
    });
    let waited = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(UPDATE_WAIT))
        .await
        .map_err(|e| e.to_string())?;
    match waited {
        Ok(0) => Ok(()),
        Ok(failed) => Err(format!(
            "Nook couldn't show {failed} of its windows before the update"
        )),
        Err(_) => Err("Nook's restore before the update didn't finish".to_string()),
    }
}

/// The last run left its journal owing, or unreadable. A dirty journal from this boot whose
/// writer is gone is put back to the originals; one from another boot is dropped, and any window
/// still carrying Nook's marker is swept back. Windows an earlier restore couldn't put back are
/// tried again.
fn check_at_start(shared: &Arc<Shared>) {
    let store = Store::in_dir(&shared.dir);
    let outcome =
        with_signals(|signals| at_start(&RealDesktop::restoring(), &store, signals, &context()));
    match outcome {
        Start::Nothing => {}
        Start::Resume(_) => diag::write(&shared.dir, &Event::NotResumed),
        Start::WriterAlive => diag::write(&shared.dir, &Event::WriterAlive),
        Start::Restored(report) => finished(shared, By::Start, &report),
        Start::Retried(report) => finished(shared, By::Retry, &report),
    }
    // The restore may have recorded an unclean end, and two of them mean safe start: then the
    // observing switch and the bar, which init may already have started, stop.
    let was = shared.status();
    shared.refresh();
    if shared.status() != was {
        observe::sync_with(shared, &mut shared.observer());
        barwin::sync(shared);
        dockwin::sync(shared);
    }
}

fn context() -> Context {
    Context::current(Some(VERSION.to_string()))
}

/// Runs `f` with this session's shared objects, or without them when another program holds
/// one of their names: the windows still come back, nobody else is told.
fn with_signals<T>(f: impl FnOnce(&dyn Signals) -> T) -> T {
    match SessionObjects::create(&session_tag()) {
        Ok(objects) => f(&objects),
        Err(_) => f(&Unshared),
    }
}

fn restore(dir: &Path, reason: Reason) -> Report {
    let store = Store::in_dir(dir);
    with_signals(|signals| {
        restore_all(
            &RealDesktop::restoring(),
            &store,
            signals,
            &context(),
            reason,
        )
    })
}

/// Logs a restore, and tells the owner when one put windows back that they didn't ask for.
fn finished(shared: &Shared, by: By, report: &Report) {
    diag::write(&shared.dir, &Event::Restored { by, report });
    if let Some(body) = toast_body(by, report.restored) {
        crate::hearth::toast::show(&shared.app, "Nook put your windows back", &body, None);
    }
}

pub(super) fn toast_body(by: By, restored: usize) -> Option<String> {
    let after = match by {
        By::Start => "after it stopped unexpectedly",
        By::Unwind => "after a problem in Nook",
        // The update was asked for, and Hearth is about to restart.
        By::Update => return None,
        // The owner already heard about these windows when the first restore ran.
        By::Retry => return None,
    };
    let windows = match restored {
        0 => return None,
        1 => "1 window".to_string(),
        n => format!("{n} windows"),
    };
    Some(format!(
        "Nook put {windows} back {after}. Arranging is off until you turn it on."
    ))
}

/// Starts one of the observer's threads. Quitting stops them rather than waiting for them, since
/// they put nothing back; if one panics, the restore runs as for any Nook thread.
pub(super) fn spawn_long(
    shared: &Arc<Shared>,
    name: &str,
    body: impl FnOnce() + Send + 'static,
    on_unwind: impl FnOnce(&str) + Send + 'static,
) -> bool {
    unwind::install_hook(shared.dir.clone());
    match unwind::spawn(name, body, on_unwind) {
        Ok(_) => true,
        Err(e) => {
            log::warn!("Couldn't start Nook's {name} thread: {e}");
            false
        }
    }
}

/// Starts a Nook thread that quitting waits for. If it panics, a fresh thread restores from
/// the journal on disk.
fn spawn(shared: &Arc<Shared>, name: &str, body: impl FnOnce() + Send + 'static) {
    unwind::install_hook(shared.dir.clone());
    // Held by the unwind handler, which outlives the body, so the count never drops to zero
    // between a panic and the restore it starts.
    let busy = shared.workers.enter();
    let after = shared.clone();
    let started = unwind::spawn(name, body, move |thread| {
        let _busy = busy;
        unwound(&after, thread);
    });
    if let Err(e) = started {
        log::warn!("Couldn't start Nook's {name} thread: {e}");
    }
}

pub(super) fn unwound(shared: &Arc<Shared>, thread: &str) {
    diag::write(&shared.dir, &Event::Unwound { thread });
    let busy = shared.workers.enter();
    let s = shared.clone();
    // A fresh thread, since the one that panicked may have left its own state half-changed.
    // If this one panics as well it is only logged, so a restore that keeps failing can't
    // keep starting itself.
    let started = unwind::spawn(
        "unwind",
        move || {
            let _busy = busy;
            let report = restore(&s.dir, Reason::Unwind);
            finished(&s, By::Unwind, &report);
            s.refresh();
        },
        |_| {},
    );
    if let Err(e) = started {
        log::warn!("Couldn't start Nook's restore after {thread} panicked: {e}");
    }
}
