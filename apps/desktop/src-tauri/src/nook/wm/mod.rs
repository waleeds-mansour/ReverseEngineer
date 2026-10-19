// nook-wm (docs/nook-wm.md, "THREADS IN hearth.exe"): the thread that owns everything Nook knows
// about windows. Others reach it through a Link: a command goes into its channel and an event
// wakes its wait, so it never polls. In P1 it observes: hooks, verdicts, focus and gates, and a
// state for Nook's pages, with every write refused by the seam.

pub mod fixtures;
pub mod gating;
pub mod state;
pub mod thread;
pub mod views;

#[cfg(test)]
mod tests;

use super::shell::Signal;
use super::sync::{self, Handle};
use super::vd::Answer;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;

/// What a Link carries back from a command that writes a file.
pub type Reply = mpsc::Sender<Result<PathBuf, String>>;

pub enum Cmd {
    Stop,
    /// The panel opened or closed.
    Panel(bool),
    /// The owner flipped the observing switch, for the state pages show.
    Observe(bool),
    /// Judge every window again.
    Refresh,
    /// The bar's seam: follow the foreground app with F1, to see a window go fullscreen, while
    /// the bar is on.
    FollowForeground(bool),
    /// The bar's and popover's windows, which never count as the window in front.
    Chrome(Vec<super::probe::Hwnd>),
    SaveFixtures(Reply),
    ExportDiag(Option<Reply>),
    Shell(Signal),
    Vd(Vec<Answer>),
}

/// The way in to nook-wm, from any thread.
#[derive(Clone)]
pub struct Link {
    tx: mpsc::Sender<Cmd>,
    wake: Arc<Handle>,
}

/// nook-wm's end.
pub struct Inbox {
    pub rx: mpsc::Receiver<Cmd>,
    pub wake: Arc<Handle>,
}

pub fn channel() -> std::io::Result<(Link, Inbox)> {
    let (tx, rx) = mpsc::channel();
    let wake = Arc::new(sync::event(None)?);
    Ok((
        Link {
            tx,
            wake: wake.clone(),
        },
        Inbox { rx, wake },
    ))
}

impl Link {
    /// False once nook-wm has gone.
    pub fn send(&self, cmd: Cmd) -> bool {
        let sent = self.tx.send(cmd).is_ok();
        if sent {
            sync::set(&self.wake);
        }
        sent
    }

    /// Sends a command that writes a file and waits up to two seconds for where it went.
    pub fn ask(&self, make: impl FnOnce(Reply) -> Cmd) -> Result<PathBuf, String> {
        let (tx, rx) = mpsc::channel();
        if !self.send(make(tx)) {
            return Err("Nook isn't observing".into());
        }
        rx.recv_timeout(std::time::Duration::from_secs(2))
            .map_err(|_| "Nook didn't answer in time".to_string())?
    }
}
