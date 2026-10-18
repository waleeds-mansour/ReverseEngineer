// The WinEvent hooks (docs/nook-wm.md, "HOOKS"). All are out of context, so callbacks run on
// nook-wm while it pumps messages and nothing is loaded into another app. All but the foreground
// hook skip Hearth's own process: Hearth's windows coming to the front must reach nook-wm, so the
// bar never hands the foreground back past one of them, and Stage A leaves them alone anyway.
// Which ones are installed decides how often nook-wm wakes:
// - G1-G5, always while observing: foreground, move/size, minimize, desktop switch, Alt-Tab.
//   All low volume.
// - SHOW/HIDE/DESTROY and CLOAKED/UNCLOAKED for everyone, only while the panel is open, so the
//   verdict list stays current. Without the panel, new windows of other apps never wake Nook.
// - P1 and P2 per managed process, from its first adopted window to its last. Nothing is
//   adopted while observing, so P1 installs none; P2 uses add_pid and remove_pid.
// - F1, LOCATIONCHANGE for the foreground managed process only, never globally.
// NAMECHANGE is never hooked: Nook shows app names, not titles.

use super::coalesce::{event as e, Coalescer};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::{self, AssertUnwindSafe};
use std::time::Instant;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS};

/// G1-G5, as (min, max) ranges.
pub const GLOBAL: [(u32, u32); 5] = [
    (e::FOREGROUND, e::FOREGROUND),
    (e::MOVESIZE_START, e::MOVESIZE_END),
    (e::MINIMIZE_START, e::MINIMIZE_END),
    (e::DESKTOP_SWITCH, e::DESKTOP_SWITCH),
    (e::SWITCH_START, e::SWITCH_END),
];
/// P1 and P2: a window's life, and its cloak.
pub const PER_PROCESS: [(u32, u32); 2] = [(e::DESTROY, e::HIDE), (e::CLOAKED, e::UNCLOAKED)];
/// F1.
pub const FOLLOW: (u32, u32) = (e::LOCATION_CHANGE, e::LOCATION_CHANGE);

thread_local! {
    /// The callback's map. Only nook-wm's thread installs hooks, so only it ever touches this.
    pub static PIPE: RefCell<Coalescer> = RefCell::new(Coalescer::default());
    /// Set when a callback panicked; the loop turns it into an ordinary panic, which unwinds
    /// into a restore like any other.
    pub static FAULT: Cell<bool> = const { Cell::new(false) };
    /// How long callbacks took, for the 5 µs budget.
    pub static TIMES: RefCell<super::perf::Histogram> = RefCell::new(super::perf::Histogram::default());
}

/// The callback. It returns quickly and never unwinds: a panic across extern "system" would
/// abort Hearth, so one is caught and reported through FAULT.
unsafe extern "system" fn on_event(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object: i32,
    child: i32,
    _thread: u32,
    time: u32,
) {
    let caught = panic::catch_unwind(AssertUnwindSafe(|| {
        let start = Instant::now();
        let _ = PIPE.try_with(|p| {
            if let Ok(mut p) = p.try_borrow_mut() {
                p.record(event, hwnd.0 as isize, object, child, time);
            }
        });
        let took = start.elapsed();
        let _ = TIMES.try_with(|t| {
            if let Ok(mut t) = t.try_borrow_mut() {
                t.add(took);
            }
        });
    }));
    if caught.is_err() {
        let _ = FAULT.try_with(|f| f.set(true));
    }
}

/// Every hook skips Hearth's own process but the foreground one.
fn flags(range: (u32, u32)) -> u32 {
    if range == (e::FOREGROUND, e::FOREGROUND) {
        WINEVENT_OUTOFCONTEXT
    } else {
        WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS
    }
}

fn install(range: (u32, u32), pid: u32) -> Option<HWINEVENTHOOK> {
    let flags = flags(range);
    let h = unsafe { SetWinEventHook(range.0, range.1, None, Some(on_event), pid, 0, flags) };
    (!h.is_invalid()).then_some(h)
}

fn remove(h: HWINEVENTHOOK) {
    unsafe {
        let _ = UnhookWinEvent(h);
    }
}

/// The hooks nook-wm holds. Dropping it removes every one, on this same thread.
#[derive(Default)]
pub struct HookSet {
    global: Vec<HWINEVENTHOOK>,
    panel: Vec<HWINEVENTHOOK>,
    per_pid: HashMap<u32, Vec<HWINEVENTHOOK>>,
    follow: Option<(u32, HWINEVENTHOOK)>,
    /// Hooks Windows refused, for diag.
    pub refused: u32,
}

impl HookSet {
    fn many(&mut self, ranges: &[(u32, u32)], pid: u32) -> Vec<HWINEVENTHOOK> {
        let mut out = Vec::with_capacity(ranges.len());
        for &r in ranges {
            match install(r, pid) {
                Some(h) => out.push(h),
                None => self.refused += 1,
            }
        }
        out
    }

    /// G1-G5. False if Windows refused one of them.
    pub fn start(&mut self) -> bool {
        if self.global.is_empty() {
            self.global = self.many(&GLOBAL, 0);
        }
        self.global.len() == GLOBAL.len()
    }

    /// Everyone's SHOW, HIDE, DESTROY and cloak, while the panel is open.
    pub fn panel(&mut self, open: bool) {
        if open && self.panel.is_empty() {
            self.panel = self.many(&PER_PROCESS, 0);
        } else if !open {
            self.panel.drain(..).for_each(remove);
        }
    }

    #[cfg(test)]
    pub fn panel_open(&self) -> bool {
        !self.panel.is_empty()
    }

    /// P1 and P2 for a process whose first window Nook adopted. Nothing is adopted until P2
    /// arranges windows; the private-desktop hook test covers it now.
    #[allow(dead_code)]
    pub fn add_pid(&mut self, pid: u32) {
        if pid != 0 && !self.per_pid.contains_key(&pid) {
            let hooks = self.many(&PER_PROCESS, pid);
            self.per_pid.insert(pid, hooks);
        }
    }

    /// When the process's last adopted window leaves.
    pub fn remove_pid(&mut self, pid: u32) {
        if let Some(hooks) = self.per_pid.remove(&pid) {
            hooks.into_iter().for_each(remove);
        }
    }

    /// F1 follows the foreground process when it is a managed one, and goes when it isn't.
    pub fn follow(&mut self, pid: Option<u32>) {
        if self.follow.map(|(p, _)| p) == pid {
            return;
        }
        if let Some((_, h)) = self.follow.take() {
            remove(h);
        }
        if let Some(pid) = pid.filter(|&p| p != 0) {
            match install(FOLLOW, pid) {
                Some(h) => self.follow = Some((pid, h)),
                None => self.refused += 1,
            }
        }
    }

    pub fn followed(&self) -> Option<u32> {
        self.follow.map(|(p, _)| p)
    }

    pub fn count(&self) -> usize {
        self.global.len()
            + self.panel.len()
            + self.per_pid.values().map(Vec::len).sum::<usize>()
            + usize::from(self.follow.is_some())
    }

    pub fn clear(&mut self) {
        self.global.drain(..).for_each(remove);
        self.panel(false);
        let pids: Vec<u32> = self.per_pid.keys().copied().collect();
        pids.into_iter().for_each(|p| self.remove_pid(p));
        self.follow(None);
    }
}

impl Drop for HookSet {
    fn drop(&mut self) {
        self.clear();
    }
}

/// Takes a callback panic on this thread, if there was one.
pub fn take_fault() -> bool {
    FAULT.try_with(|f| f.replace(false)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_foreground_hook_hears_hearths_own_windows() {
        assert_eq!(GLOBAL[0], (e::FOREGROUND, e::FOREGROUND));
        assert_eq!(flags(GLOBAL[0]) & WINEVENT_SKIPOWNPROCESS, 0);
        for range in GLOBAL[1..].iter().chain(&PER_PROCESS).chain([&FOLLOW]) {
            assert_ne!(flags(*range) & WINEVENT_SKIPOWNPROCESS, 0, "{range:?}");
        }
    }
}
