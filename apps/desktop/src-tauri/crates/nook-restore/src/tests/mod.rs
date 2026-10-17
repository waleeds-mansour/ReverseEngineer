// Tests for the restore. Everything here runs against FakeDesktop and FakeSignals, except
// `objects` (named kernel objects under a tag of the test's own, no windows) and `private_desktop`
// (real windows this test creates on a desktop of its own, never shown and never switched to).

mod cli;
mod fault;
mod guard;
mod identity;
mod journal;
mod log;
#[cfg(windows)]
mod objects;
mod owed;
#[cfg(windows)]
mod private_desktop;
mod recover;
mod revoke;
mod start;
mod support;
mod timing;
