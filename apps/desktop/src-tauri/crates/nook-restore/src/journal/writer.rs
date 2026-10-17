// The window manager's only way to write the journal. It holds an epoch: a restorer raises the
// epoch before it touches anything, and from then on every write from this writer is refused, so
// a stalled window manager can never journal (and so never apply) a layout over a restore.

use super::{next_epoch, Journal, Loaded, State, Store};
use crate::clock::Clock;
use crate::objects::{Held, Signals};
use std::fmt;
use std::io;
use std::time::Duration;

#[derive(Debug)]
pub enum WriteError {
    /// Another party holds the journal mutex past the wait; the window manager pauses.
    LockTimeout,
    /// A restorer started; this writer is done for good.
    Revoked,
    /// The file carries a newer epoch than this writer's.
    Stale {
        file: u64,
        own: u64,
    },
    /// The journal on disk owes a restore (or is unreadable), so nobody may take it over yet. A
    /// clean journal still owes one while it lists a window an earlier restore couldn't put back.
    Dirty(String),
    Io(io::Error),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::LockTimeout => f.write_str("the journal is busy"),
            WriteError::Revoked => f.write_str("a restore started"),
            WriteError::Stale { file, own } => {
                write!(f, "the journal's epoch {file} is newer than {own}")
            }
            WriteError::Dirty(why) => write!(f, "the journal owes a restore first ({why})"),
            WriteError::Io(e) => write!(f, "can't write the journal: {e}"),
        }
    }
}

impl std::error::Error for WriteError {}

pub struct Writer {
    store: Store,
    epoch: u64,
}

impl Writer {
    /// How long the window manager waits for the journal mutex before it pauses instead.
    pub const LOCK_WAIT: Duration = Duration::from_millis(200);

    /// Takes over the journal as its only writer, with an epoch above every earlier one, and
    /// writes `journal` as the first entry. Refused while the journal on disk still owes a
    /// restore: the restore runs first, so this run never inherits another run's windows, and a
    /// window an earlier restore couldn't put back is never dropped from the journal.
    pub fn claim(
        store: Store,
        signals: &dyn Signals,
        journal: &mut Journal,
        clock: Clock,
    ) -> Result<Writer, WriteError> {
        let _held = Held::take(signals, Self::LOCK_WAIT).ok_or(WriteError::LockTimeout)?;
        let seen = match store.load() {
            Loaded::Missing => None,
            Loaded::Found(old) if !old.owes_restore() => Some(old.epoch),
            Loaded::Found(old) if old.state.is_clean() => {
                return Err(WriteError::Dirty("windows still owed".into()))
            }
            Loaded::Found(old) => return Err(WriteError::Dirty(format!("{:?}", old.state))),
            Loaded::Corrupt(why) => return Err(WriteError::Dirty(why)),
        };
        store.tidy();
        let epoch = next_epoch(seen.max(Some(signals.epoch())), clock.now_ms);
        signals.begin(epoch);
        journal.epoch = epoch;
        journal.state = State::Active;
        stamp(journal, clock);
        store.save(journal).map_err(WriteError::Io)?;
        Ok(Writer { store, epoch })
    }

    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Writes the journal if this writer still owns it: not revoked, and no newer epoch on disk.
    pub fn write(
        &mut self,
        signals: &dyn Signals,
        journal: &mut Journal,
        clock: Clock,
    ) -> Result<(), WriteError> {
        if signals.is_revoked(self.epoch) {
            return Err(WriteError::Revoked);
        }
        let _held = Held::take(signals, Self::LOCK_WAIT).ok_or(WriteError::LockTimeout)?;
        // Again under the mutex: a restorer may have revoked while this writer waited for it.
        if signals.is_revoked(self.epoch) {
            return Err(WriteError::Revoked);
        }
        match self.store.load() {
            Loaded::Found(on_disk) if on_disk.epoch > self.epoch => {
                return Err(WriteError::Stale {
                    file: on_disk.epoch,
                    own: self.epoch,
                })
            }
            Loaded::Corrupt(why) => return Err(WriteError::Dirty(why)),
            Loaded::Found(_) | Loaded::Missing => {}
        }
        journal.epoch = self.epoch;
        stamp(journal, clock);
        self.store.save(journal).map_err(WriteError::Io)
    }
}

/// Every write counts up and records both clocks, so a later restorer can tell this boot's
/// journal from an earlier boot's.
pub(crate) fn stamp(journal: &mut Journal, clock: Clock) {
    journal.seq += 1;
    journal.written_at = clock.now_ms;
    journal.ticks = clock.ticks_ms;
}
