// The check at every start (docs/nook-wm.md, "WHO RUNS IT"): a dirty journal from this boot
// whose writer is gone is restored to the originals; one from another boot has its entries
// dropped. A journal an earlier restore finished, but with windows it couldn't put back, is tried
// again.

use super::{origin, restore_all, Context, Origin, Reason, Report};
use crate::desktop::Desktop;
use crate::journal::{Journal, Loaded, State, Store, SCHEMA};
use crate::objects::Signals;

/// A 'clean-for-update' journal older than this is not resumed.
pub const RESUME_WITHIN_MS: u64 = 15 * 60 * 1000;

/// What the next start found, and did.
#[derive(Debug)]
pub enum Start {
    /// Nothing is owed.
    Nothing,
    /// Hearth was updated a moment ago: the window manager re-adopts these windows in place.
    Resume(Box<Journal>),
    /// The process that wrote the journal still runs (another copy of Hearth); not ours to undo.
    WriterAlive,
    Restored(Report),
    /// An earlier restore left windows it couldn't put back; this was another try at them.
    Retried(Report),
}

pub fn at_start(
    desktop: &dyn Desktop,
    store: &Store,
    signals: &dyn Signals,
    ctx: &Context,
) -> Start {
    let journal = match store.load() {
        Loaded::Missing => return Start::Nothing,
        Loaded::Corrupt(_) => {
            return Start::Restored(restore_all(desktop, store, signals, ctx, Reason::Start))
        }
        Loaded::Found(journal) => journal,
    };
    let other_boot = origin(&journal, ctx) == Origin::OtherBoot;
    match journal.state {
        // A restorer finished this journal and fenced its writer, so nobody else writes to these
        // windows; an update's leftovers keep the update's policy and stay where they are.
        State::Clean | State::CleanForUpdate if journal.owes_restore() => {
            let reason = match journal.state {
                State::CleanForUpdate => Reason::Update,
                _ => Reason::Retry,
            };
            return Start::Retried(restore_all(desktop, store, signals, ctx, reason));
        }
        State::Clean => return Start::Nothing,
        State::CleanForUpdate => {
            let recent = ctx.now_ms.saturating_sub(journal.written_at) <= RESUME_WITHIN_MS;
            let fresh = journal.resume && recent && !other_boot && journal.v == SCHEMA;
            return if fresh {
                Start::Resume(Box::new(journal))
            } else {
                Start::Nothing
            };
        }
        _ => {}
    }
    let writer_alive = desktop.process_start(journal.pid) == Some(journal.proc_start);
    if writer_alive && !other_boot {
        return Start::WriterAlive;
    }
    Start::Restored(restore_all(desktop, store, signals, ctx, Reason::Start))
}
