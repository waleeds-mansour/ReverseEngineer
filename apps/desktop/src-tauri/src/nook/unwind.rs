// Nook's threads, and what happens when one panics (docs/nook-wm.md, "PANIC POLICY"). Every
// thread is named nook-<something> and runs its body inside catch_unwind, so a bug in Nook unwinds
// into a restore instead of leaving windows where a half-finished pass put them. The panic hook is
// chained to whatever hook was set before it and only adds a nook.log line for threads named
// nook-; Hearth's other panics go exactly where they went before.

use super::diag::{self, Event};
use std::any::Any;
use std::panic::{self, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex, Once};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const PREFIX: &str = "nook-";

static HOOK: Once = Once::new();

/// Installs the chained panic hook, once per process. It is installed with the first Nook thread,
/// so a Hearth whose Nook does nothing never changes its panic handling at all.
pub fn install_hook(dir: PathBuf) {
    HOOK.call_once(move || {
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            let thread = std::thread::current();
            if let Some(name) = thread.name().filter(|n| n.starts_with(PREFIX)) {
                let at = info
                    .location()
                    .map(|l| format!("{}:{}", l.file(), l.line()))
                    .unwrap_or_default();
                let message = message(info.payload());
                diag::write_from_hook(
                    &dir,
                    &Event::Panicked {
                        thread: name,
                        at: &at,
                        message: &message,
                    },
                );
            }
            previous(info);
        }));
    });
}

/// A panic's message, for the payloads `panic!` makes.
pub fn message(payload: &(dyn Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_string()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "a panic without a message".to_string()
    }
}

/// Runs `body`; if it panics, runs `on_unwind` with the thread's name. Unwinding stops here, so a
/// Nook thread never takes Hearth down with it.
pub fn guarded<F, U>(name: &str, body: F, on_unwind: U)
where
    F: FnOnce(),
    U: FnOnce(&str),
{
    if panic::catch_unwind(AssertUnwindSafe(body)).is_err() {
        on_unwind(name);
    }
}

/// Starts a thread named nook-`name` running `body` inside [`guarded`].
pub fn spawn<F, U>(name: &str, body: F, on_unwind: U) -> std::io::Result<JoinHandle<()>>
where
    F: FnOnce() + Send + 'static,
    U: FnOnce(&str) + Send + 'static,
{
    let name = format!("{PREFIX}{name}");
    std::thread::Builder::new()
        .name(name.clone())
        .spawn(move || guarded(&name, body, on_unwind))
}

/// Counts Nook's threads that are still putting windows back, so quitting can let them finish.
#[derive(Default)]
pub struct Workers {
    running: Mutex<usize>,
    idle: Condvar,
}

/// One running thread; counted until it is dropped, which also happens while a panic unwinds.
pub struct Busy(Arc<Workers>);

impl Workers {
    pub fn enter(self: &Arc<Self>) -> Busy {
        *self.running.lock().unwrap_or_else(|p| p.into_inner()) += 1;
        Busy(self.clone())
    }

    /// Waits until no thread is running, up to `timeout`. False if one still is.
    pub fn wait_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        while *running > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            running = self
                .idle
                .wait_timeout(running, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        true
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        let mut running = self.0.running.lock().unwrap_or_else(|p| p.into_inner());
        *running = running.saturating_sub(1);
        if *running == 0 {
            self.0.idle.notify_all();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_panic_is_caught_and_handed_on_with_the_thread_name() {
        let mut unwound = None;
        guarded(
            "nook-test",
            || panic!("on purpose"),
            |name| unwound = Some(name.to_string()),
        );
        assert_eq!(unwound.as_deref(), Some("nook-test"));
    }

    #[test]
    fn a_body_that_finishes_never_unwinds() {
        let mut ran = false;
        let mut unwound = false;
        guarded("nook-test", || ran = true, |_| unwound = true);
        assert!(ran);
        assert!(!unwound);
    }

    #[test]
    fn threads_are_named_for_nook() {
        let (tx, rx) = mpsc::channel();
        let thread = spawn(
            "name",
            move || {
                let name = std::thread::current().name().map(String::from);
                tx.send(name).unwrap();
            },
            |_| {},
        )
        .unwrap();
        thread.join().unwrap();
        assert_eq!(rx.recv().unwrap().as_deref(), Some("nook-name"));
    }

    #[test]
    fn a_panic_message_reads_from_either_payload() {
        let text: Box<dyn Any + Send> = Box::new("static");
        assert_eq!(message(text.as_ref()), "static");
        let owned: Box<dyn Any + Send> = Box::new(format!("owned {}", 1));
        assert_eq!(message(owned.as_ref()), "owned 1");
        let other: Box<dyn Any + Send> = Box::new(7u8);
        assert_eq!(message(other.as_ref()), "a panic without a message");
    }

    #[test]
    fn workers_count_down_even_when_a_thread_panics() {
        let workers = Arc::new(Workers::default());
        assert!(workers.wait_idle(Duration::ZERO));
        let busy = workers.enter();
        assert!(!workers.wait_idle(Duration::from_millis(10)));
        let thread = std::thread::spawn(move || {
            let _busy = busy;
            std::thread::sleep(Duration::from_millis(50));
        });
        assert!(workers.wait_idle(Duration::from_secs(5)));
        thread.join().unwrap();

        let busy = workers.enter();
        let _ = panic::catch_unwind(AssertUnwindSafe(move || {
            let _busy = busy;
            panic!("on purpose");
        }));
        assert!(workers.wait_idle(Duration::ZERO));
    }

    // The only test that installs the hook, and the only one that panics on a nook- thread, so
    // the hook's folder is this test's own.
    #[test]
    fn the_hook_logs_nook_threads_only() {
        let tmp = tempfile::tempdir().unwrap();
        install_hook(tmp.path().to_path_buf());
        let log = || {
            std::fs::read_to_string(tmp.path().join(nook_restore::log::FILE_NAME))
                .unwrap_or_default()
        };

        let other = std::thread::Builder::new()
            .name("someone-else".into())
            .spawn(|| panic!("not Nook's"))
            .unwrap();
        assert!(other.join().is_err());
        assert_eq!(log(), "");

        let nook = std::thread::Builder::new()
            .name("nook-hook-test".into())
            .spawn(|| panic!("Nook's own"))
            .unwrap();
        assert!(nook.join().is_err());
        let text = log();
        assert!(text.contains("panic in nook-hook-test at "), "{text}");
        assert!(text.contains("unwind.rs:"), "{text}");
        assert!(text.contains(": Nook's own"), "{text}");
    }
}
