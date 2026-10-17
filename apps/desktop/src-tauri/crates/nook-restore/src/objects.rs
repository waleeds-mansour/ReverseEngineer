// The signals Nook's parties share (docs/nook-wm.md, "Architecture" and "STATE OWNERSHIP"). On
// Windows they are named kernel objects in the session's Local\ namespace: the Restore, Revoked,
// Done and Armed events, the Beat shared section and the Journal mutex. The restore logic only
// sees the `Signals` trait, so tests run it against FakeSignals without creating any of them.

use std::time::Duration;

#[cfg(windows)]
pub mod session;

/// What a restorer, a journal writer and the desktop seam need from the shared objects.
pub trait Signals: Send + Sync {
    /// Sets Revoked and raises the shared epoch to at least `epoch`, so every writer that took
    /// over earlier stops at its next call.
    fn revoke(&self, epoch: u64);

    /// Whether a writer holding `epoch` must stop: Revoked is set, or a later epoch took over.
    fn is_revoked(&self, epoch: u64) -> bool;

    /// The highest epoch any party has taken while the shared objects existed.
    fn epoch(&self) -> u64;

    /// A new writer took over at `epoch`: clears Revoked and raises the shared epoch, so only
    /// writers older than it stay stopped.
    fn begin(&self, epoch: u64);

    /// Takes the journal mutex, waiting up to `timeout`. False when it is still held elsewhere.
    fn lock_journal(&self, timeout: Duration) -> bool;

    /// Releases the journal mutex, on the thread that took it.
    fn unlock_journal(&self);

    /// The restore finished: clears Restore and Armed and sets Done, which the CLI and the
    /// guard wait on.
    fn finished(&self);
}

/// The journal mutex, released when this goes out of scope.
pub struct Held<'a>(&'a dyn Signals);

impl<'a> Held<'a> {
    pub fn take(signals: &'a dyn Signals, timeout: Duration) -> Option<Held<'a>> {
        signals.lock_journal(timeout).then_some(Held(signals))
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        self.0.unlock_journal();
    }
}

/// Signals for a restorer that could not create the shared objects (another program holds one
/// of their names with the wrong type). Windows still come back; nothing else is told.
pub struct Unshared;

impl Signals for Unshared {
    fn revoke(&self, _epoch: u64) {}
    fn is_revoked(&self, _epoch: u64) -> bool {
        // Without the shared objects nothing can stop a writer, so no writer may write.
        true
    }
    fn epoch(&self) -> u64 {
        0
    }
    fn begin(&self, _epoch: u64) {}
    fn lock_journal(&self, _timeout: Duration) -> bool {
        // There is no mutex to take. Saying so makes a restorer treat its journal writes as
        // unguarded and check them again, and keeps any writer from claiming the journal.
        false
    }
    fn unlock_journal(&self) {}
    fn finished(&self) {}
}

/// The full name of one shared object, like `Local\Nook.Revoked.1`. `tag` is the Windows session
/// id for the real objects, so the CLI and the installer find them without reading the journal;
/// tests pass their own tag so they never touch the live ones.
pub fn object_name(kind: &str, tag: &str) -> String {
    format!("Local\\Nook.{kind}.{tag}")
}

/// Why a restore was asked for over the Beat section, as a number another process can read.
pub fn reason_code(reason: crate::recover::Reason) -> u32 {
    use crate::recover::Reason::*;
    match reason {
        User => 1,
        Update => 2,
        Uninstall => 3,
        Panic => 4,
        Quit => 5,
        Disable => 6,
        Guard => 7,
        Start => 8,
        Unwind => 9,
        SessionEnd => 10,
        Retry => 11,
    }
}

/// The reason behind a code; an unknown one means the safest restore, back to the originals.
pub fn reason_from_code(code: u32) -> crate::recover::Reason {
    use crate::recover::Reason::*;
    match code {
        2 => Update,
        3 => Uninstall,
        4 => Panic,
        5 => Quit,
        6 => Disable,
        7 => Guard,
        8 => Start,
        9 => Unwind,
        10 => SessionEnd,
        11 => Retry,
        _ => User,
    }
}
