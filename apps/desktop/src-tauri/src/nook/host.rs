// Nook's part of the app on Windows: its folder, its status, the start check, the restore before
// an update, and its threads. Every restore here is nook-restore's restore_all on the real
// desktop, which is tested in that crate against FakeDesktop and on private desktops; the tests
// here cover only what this file decides on its own.

use super::diag::{self, By, Event};
use super::start::{self, Status};
use super::{settings, unwind};
use nook_restore::journal::Loaded;
use nook_restore::objects::session::{session_tag, SessionObjects};
use nook_restore::objects::Unshared;
use nook_restore::recover::{at_start, Start};
use nook_restore::{restore_all, Context, RealDesktop, Reason, Report, Signals, Store};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// This build's version as CI numbered it (build.rs), so the journal and the restore CLI agree
/// on which Hearth wrote what.
const VERSION: &str = env!("HEARTH_VERSION");
/// How long quitting waits for a restore that is still running.
const QUIT_WAIT: Duration = Duration::from_secs(3);
/// How long the settings window waits for the restore before an update.
const UPDATE_WAIT: Duration = Duration::from_secs(10);

/// Nook in the app, as Tauri state. The window manager's command channel joins it with the
/// window manager (P1); until then it holds where Nook's files are and why Nook is off.
pub struct NookHandle(Arc<Shared>);

struct Shared {
    app: AppHandle,
    dir: PathBuf,
    /// A snapshot, replaced whenever something changes it.
    status: Mutex<Status>,
    workers: Arc<unwind::Workers>,
}

impl Shared {
    fn status(&self) -> Status {
        *self.status.lock().unwrap_or_else(|p| p.into_inner())
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
    let plan = plan(&dir, &settings::load(app));
    let shared = Arc::new(Shared {
        app: app.clone(),
        dir,
        status: Mutex::new(plan.status),
        workers: Arc::default(),
    });
    shared.refresh();
    app.manage(NookHandle(shared.clone()));
    if plan.check {
        let s = shared.clone();
        spawn(&shared, "start", move || check_at_start(&s));
    }
}

pub fn shutdown(app: &AppHandle) {
    let Some(handle) = app.try_state::<NookHandle>() else {
        return;
    };
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
fn check_at_start(shared: &Shared) {
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
    // The restore may have recorded an unclean end, and two of them mean safe start.
    shared.refresh();
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

fn unwound(shared: &Arc<Shared>, thread: &str) {
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
