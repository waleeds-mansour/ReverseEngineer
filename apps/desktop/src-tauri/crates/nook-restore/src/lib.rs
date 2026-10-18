//! Puts back the windows Nook arranged (docs/nook-wm.md, D75).
//!
//! Every change Nook makes to another app's window is written to the journal first. Whoever
//! notices that Nook stopped (the window manager itself, the `--nook-restore-windows` CLI,
//! nook-guard.exe, the next start or the installer) runs the same [`recover::restore_all`], so a
//! window comes back the same way on every exit path. [`guard`] starts nook-guard.exe and holds
//! its watch loop.
//!
//! The Win32 parts (the real desktop, the named objects, the CLI) exist only on Windows. The
//! journal, the identity check, the restore order and FakeDesktop are plain Rust, so their tests
//! run without touching a single real window.

pub mod cli;
pub mod clock;
pub mod desktop;
pub mod guard;
pub mod identity;
pub mod journal;
pub mod log;
pub mod objects;
pub mod placement;
pub mod recover;

pub use clock::Clock;
pub use desktop::{Desktop, DesktopError, Mode};
pub use identity::Identity;
pub use journal::{Journal, Loaded, Store, Writer};
pub use objects::Signals;
pub use placement::{Hwnd, Placement, Point, Rect};
pub use recover::{restore_all, Context, Reason, Report};

#[cfg(any(test, feature = "fake"))]
pub use desktop::fake::{FakeDesktop, FakeSignals, FakeWindow};
#[cfg(windows)]
pub use desktop::real::RealDesktop;
#[cfg(windows)]
pub use objects::session::SessionObjects;

#[cfg(test)]
mod tests;
