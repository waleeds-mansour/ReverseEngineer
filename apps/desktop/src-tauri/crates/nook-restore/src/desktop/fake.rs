// FakeDesktop: a model of the window states a restore cares about, so the restore logic is
// tested without touching a real window. Handles share one world, so a test can run a "window
// manager" and a restorer side by side, each in its own mode. Every write is checked and recorded
// under one lock, which makes "no write after revoke" exact rather than a matter of timing.
//
// Hooks model what Windows and timing can do to a real write: a busy window queues asynchronous
// placements until it is free again, a gap stalls one handle between its check and its call, and
// a denied window refuses every write, as an elevated app's window does.

use super::{check, Desktop, DesktopError, Mode};
use crate::placement::*;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard};

mod signals;
mod window;
pub use signals::FakeSignals;
use signals::Lock;
pub use window::FakeWindow;
use window::{place, show};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Placement(Placement),
    ShowNoActivate,
    Uncloak,
    SetMarker(u32),
    RemoveMarker,
    BorderColor(u32),
    Transitions(bool),
    RemoveAppBar,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Write {
    pub by: &'static str,
    pub hwnd: Hwnd,
    pub change: Change,
}

type Gap = Box<dyn FnOnce() + Send>;

#[derive(Default)]
struct World {
    windows: BTreeMap<Hwnd, FakeWindow>,
    processes: BTreeMap<u32, u64>,
    appbars: Vec<Hwnd>,
    writes: Vec<Write>,
    refused: Vec<(&'static str, DesktopError)>,
    revoked: bool,
    epoch: u64,
    /// How many writes had landed when the first revoke came.
    revoked_after: Option<usize>,
    finished: usize,
    /// Panic in this handle's write once it has made this many.
    fault: Option<(&'static str, usize)>,
    /// Busy windows, each with the asynchronous writes it hasn't handled yet, oldest first.
    busy: BTreeMap<Hwnd, Vec<Change>>,
    /// Each runs once, between the check and the call of the named handle's first write after
    /// it has made that many.
    gaps: Vec<(&'static str, usize, Gap)>,
    denied: BTreeSet<Hwnd>,
}

#[derive(Clone)]
pub struct FakeDesktop {
    world: Arc<Mutex<World>>,
    lock: Arc<Lock>,
    mode: Mode,
    name: &'static str,
}

fn guard<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // An injected fault may panic while a test holds a handle; the world stays usable.
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Whether Windows posts this write to the window's own thread rather than making it at once:
/// ShowWindowAsync, and SetWindowPlacement with WPF_ASYNCWINDOWPLACEMENT.
fn posted(change: &Change) -> bool {
    match change {
        Change::Placement(p) => p.flags & WPF_ASYNCWINDOWPLACEMENT != 0,
        Change::ShowNoActivate => true,
        _ => false,
    }
}

fn apply(w: &mut World, hwnd: Hwnd, change: &Change) -> Result<(), DesktopError> {
    if *change == Change::RemoveAppBar {
        w.appbars.retain(|h| *h != hwnd);
        return Ok(());
    }
    let win = w.windows.get_mut(&hwnd).ok_or(DesktopError::Gone)?;
    match change {
        Change::Placement(p) => place(win, p),
        Change::ShowNoActivate => show(win, SW_SHOWNOACTIVATE),
        Change::Uncloak => win.cloaked = false,
        Change::SetMarker(bits) => win.marker = Some(*bits),
        Change::RemoveMarker => win.marker = None,
        Change::BorderColor(color) => win.border = *color,
        Change::Transitions(disabled) => win.transitions_disabled = *disabled,
        Change::RemoveAppBar => {}
    }
    Ok(())
}

impl Default for FakeDesktop {
    fn default() -> Self {
        FakeDesktop::new()
    }
}

impl FakeDesktop {
    /// An empty world, seen by an observer that can't write.
    pub fn new() -> FakeDesktop {
        FakeDesktop {
            world: Arc::default(),
            lock: Arc::default(),
            mode: Mode::Observing,
            name: "observer",
        }
    }

    /// Another handle on the same world, writing in `mode`; `name` labels its writes.
    pub fn handle(&self, mode: Mode, name: &'static str) -> FakeDesktop {
        FakeDesktop {
            mode,
            name,
            ..self.clone()
        }
    }

    pub fn signals(&self) -> FakeSignals {
        FakeSignals {
            world: self.world.clone(),
            lock: self.lock.clone(),
        }
    }

    pub fn add_process(&self, pid: u32, start: u64) {
        guard(&self.world).processes.insert(pid, start);
    }

    /// The process exits, and its windows with it.
    pub fn end_process(&self, pid: u32) {
        let mut w = guard(&self.world);
        w.processes.remove(&pid);
        w.windows.retain(|_, win| win.pid != pid);
    }

    pub fn add_window(&self, hwnd: Hwnd, win: FakeWindow) {
        guard(&self.world).windows.insert(hwnd, win);
    }

    pub fn add_appbar(&self, hwnd: Hwnd) {
        guard(&self.world).appbars.push(hwnd);
    }

    pub fn appbars(&self) -> Vec<Hwnd> {
        guard(&self.world).appbars.clone()
    }

    pub fn destroy(&self, hwnd: Hwnd) {
        guard(&self.world).windows.remove(&hwnd);
    }

    pub fn window(&self, hwnd: Hwnd) -> Option<FakeWindow> {
        guard(&self.world).windows.get(&hwnd).cloned()
    }

    /// The user (not Nook) gives the window a show command, like clicking minimize.
    pub fn user_show(&self, hwnd: Hwnd, show_cmd: u32) {
        if let Some(win) = guard(&self.world).windows.get_mut(&hwnd) {
            show(win, show_cmd);
        }
    }

    /// A busy app's window: asynchronous writes to it are accepted and queued, and land in order
    /// when it is free again. Reads keep showing the window as it was until then.
    pub fn set_busy(&self, hwnd: Hwnd, busy: bool) {
        let mut w = guard(&self.world);
        if busy {
            w.busy.entry(hwnd).or_default();
            return;
        }
        for change in w.busy.remove(&hwnd).unwrap_or_default() {
            let _ = apply(&mut w, hwnd, &change);
        }
    }

    /// The handle named `name` stalls in its next write after the check has passed: `gap` runs
    /// with the world unlocked, and then the write lands without being checked again, as a real
    /// thread preempted between the check and its call would.
    pub fn gap_once(&self, name: &'static str, gap: impl FnOnce() + Send + 'static) {
        self.gap_after(name, 0, gap);
    }

    /// As gap_once, in the first write the handle makes after it has made `writes` writes.
    pub fn gap_after(
        &self,
        name: &'static str,
        writes: usize,
        gap: impl FnOnce() + Send + 'static,
    ) {
        guard(&self.world).gaps.push((name, writes, Box::new(gap)));
    }

    /// Windows refuses every write to the window while `denied`, as for an elevated app's.
    pub fn deny(&self, hwnd: Hwnd, denied: bool) {
        let mut w = guard(&self.world);
        if denied {
            w.denied.insert(hwnd);
        } else {
            w.denied.remove(&hwnd);
        }
    }

    pub fn writes(&self) -> Vec<Write> {
        guard(&self.world).writes.clone()
    }

    pub fn writes_by(&self, name: &str) -> usize {
        guard(&self.world)
            .writes
            .iter()
            .filter(|w| w.by == name)
            .count()
    }

    pub fn refused_by(&self, name: &str) -> usize {
        guard(&self.world)
            .refused
            .iter()
            .filter(|r| r.0 == name)
            .count()
    }

    pub fn revoked_after(&self) -> Option<usize> {
        guard(&self.world).revoked_after
    }

    pub fn finished_count(&self) -> usize {
        guard(&self.world).finished
    }

    /// Makes the handle named `name` panic on its write after `writes` writes, as if that thread
    /// died there. None clears it.
    pub fn fault_after(&self, name: &'static str, writes: Option<usize>) {
        guard(&self.world).fault = writes.map(|n| (name, n));
    }

    fn write(&self, hwnd: Hwnd, change: Change) -> Result<(), DesktopError> {
        let mut w = guard(&self.world);
        let (revoked, epoch) = (w.revoked, w.epoch);
        if let Err(e) = check(&self.mode, |own| revoked || epoch > own) {
            w.refused.push((self.name, e));
            return Err(e);
        }
        let made = w.writes.iter().filter(|x| x.by == self.name).count();
        let due = |(who, after, _): &(&str, usize, Gap)| *who == self.name && made >= *after;
        if let Some(at) = w.gaps.iter().position(due) {
            let (_, _, gap) = w.gaps.remove(at);
            drop(w);
            gap();
            w = guard(&self.world);
        }
        if w.denied.contains(&hwnd) {
            w.refused.push((self.name, DesktopError::Denied));
            return Err(DesktopError::Denied);
        }
        if let Some((who, after)) = w.fault {
            if who == self.name && w.writes.iter().filter(|x| x.by == who).count() >= after {
                drop(w);
                panic!("injected fault in {who} after {after} writes");
            }
        }
        let queued = posted(&change) && w.windows.contains_key(&hwnd);
        match w.busy.get_mut(&hwnd) {
            Some(queue) if queued => queue.push(change.clone()),
            _ => apply(&mut w, hwnd, &change)?,
        }
        let by = self.name;
        w.writes.push(Write { by, hwnd, change });
        Ok(())
    }

    fn read<T>(&self, hwnd: Hwnd, f: impl FnOnce(&FakeWindow) -> T) -> Option<T> {
        guard(&self.world).windows.get(&hwnd).map(f)
    }
}

impl Desktop for FakeDesktop {
    fn mode(&self) -> Mode {
        self.mode
    }
    fn is_window(&self, hwnd: Hwnd) -> bool {
        self.read(hwnd, |_| ()).is_some()
    }
    fn window_pid(&self, hwnd: Hwnd) -> Option<u32> {
        self.read(hwnd, |w| w.pid)
    }
    fn process_start(&self, pid: u32) -> Option<u64> {
        guard(&self.world).processes.get(&pid).copied()
    }
    fn class_name(&self, hwnd: Hwnd) -> Option<String> {
        self.read(hwnd, |w| w.class.clone())
    }
    fn placement(&self, hwnd: Hwnd) -> Option<Placement> {
        self.read(hwnd, |w| w.placement)
    }
    fn is_visible(&self, hwnd: Hwnd) -> bool {
        self.read(hwnd, |w| w.visible).unwrap_or(false)
    }
    fn marker(&self, hwnd: Hwnd) -> Option<u32> {
        self.read(hwnd, |w| w.marker).flatten()
    }
    fn marked(&self) -> Vec<(Hwnd, u32)> {
        let w = guard(&self.world);
        let marked = w
            .windows
            .iter()
            .filter_map(|(h, win)| win.marker.map(|b| (*h, b)));
        marked.collect()
    }
    fn set_placement(&self, hwnd: Hwnd, placement: &Placement) -> Result<(), DesktopError> {
        self.write(hwnd, Change::Placement(*placement))
    }
    fn show_no_activate(&self, hwnd: Hwnd) -> Result<(), DesktopError> {
        self.write(hwnd, Change::ShowNoActivate)
    }
    fn uncloak(&self, hwnd: Hwnd) -> Result<(), DesktopError> {
        self.write(hwnd, Change::Uncloak)
    }
    fn set_marker(&self, hwnd: Hwnd, bits: u32) -> Result<(), DesktopError> {
        self.write(hwnd, Change::SetMarker(bits))
    }
    fn remove_marker(&self, hwnd: Hwnd) -> Result<(), DesktopError> {
        self.write(hwnd, Change::RemoveMarker)
    }
    fn set_border_color(&self, hwnd: Hwnd, color: u32) -> Result<(), DesktopError> {
        self.write(hwnd, Change::BorderColor(color))
    }
    fn set_transitions_disabled(&self, hwnd: Hwnd, disabled: bool) -> Result<(), DesktopError> {
        self.write(hwnd, Change::Transitions(disabled))
    }
    fn remove_appbar(&self, hwnd: Hwnd) -> Result<(), DesktopError> {
        self.write(hwnd, Change::RemoveAppBar)
    }
}
