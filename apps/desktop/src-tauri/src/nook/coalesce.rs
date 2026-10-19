// The in-callback coalescer (docs/nook-wm.md, "CALLBACK" and "FLUSH"). The WinEvent callback runs
// on nook-wm while it pumps messages, and does no Win32 call of its own: it ORs the event's bit
// into a per-window entry of a map reserved up front, so a burst of events about one window
// costs one entry and nothing is allocated in steady state. The loop flushes on the leading edge
// when 16 ms have passed since the last flush, and otherwise arms its high-resolution timer for
// the rest, so a drag at 1000 Hz still means at most about 60 flushes a second.

use super::probe::Hwnd;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Reserved up front. Events about more distinct windows than this between two flushes are
/// dropped and counted, so the callback never allocates; the flush then looks again itself.
pub const CAPACITY: usize = 512;
/// The shortest time between two flushes.
pub const MIN_GAP: Duration = Duration::from_millis(16);

pub mod event {
    pub const FOREGROUND: u32 = 0x0003;
    pub const MOVESIZE_START: u32 = 0x000A;
    pub const MOVESIZE_END: u32 = 0x000B;
    pub const SWITCH_START: u32 = 0x0014;
    pub const SWITCH_END: u32 = 0x0015;
    pub const MINIMIZE_START: u32 = 0x0016;
    pub const MINIMIZE_END: u32 = 0x0017;
    pub const DESKTOP_SWITCH: u32 = 0x0020;
    pub const DESTROY: u32 = 0x8001;
    pub const SHOW: u32 = 0x8002;
    pub const HIDE: u32 = 0x8003;
    pub const LOCATION_CHANGE: u32 = 0x800B;
    pub const CLOAKED: u32 = 0x8017;
    pub const UNCLOAKED: u32 = 0x8018;
}

/// What happened to one window since the last flush.
pub mod bit {
    pub const DESTROYED: u16 = 1 << 0;
    pub const SHOWN: u16 = 1 << 1;
    pub const HIDDEN: u16 = 1 << 2;
    pub const CLOAKED: u16 = 1 << 3;
    pub const UNCLOAKED: u16 = 1 << 4;
    pub const MIN_START: u16 = 1 << 5;
    pub const MIN_END: u16 = 1 << 6;
    pub const MOVE_START: u16 = 1 << 7;
    pub const MOVE_END: u16 = 1 << 8;
    pub const LOCATED: u16 = 1 << 9;
}

/// What happened to the desktop as a whole since the last flush.
pub mod global {
    pub const DESKTOP_SWITCH: u8 = 1 << 0;
    pub const SWITCH_START: u8 = 1 << 1;
    pub const SWITCH_END: u8 = 1 << 2;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Delta {
    pub bits: u16,
    /// The last event's time, in ms since boot as Windows stamped it.
    pub last_ms: u32,
}

/// One flush's worth of events.
#[derive(Debug, Default)]
pub struct Batch {
    pub windows: Vec<(Hwnd, Delta)>,
    pub foreground: Option<Hwnd>,
    pub global: u8,
    /// The map was full, so events about some windows were dropped.
    pub overflowed: bool,
}

pub struct Coalescer {
    map: HashMap<Hwnd, Delta>,
    /// The windows Nook has a verdict for; HIDE and DESTROY of any other are dropped.
    known: HashSet<Hwnd>,
    foreground: Option<Hwnd>,
    global: u8,
    dragging: bool,
    overflowed: bool,
    pub pending: bool,
    pub events_in: u64,
    pub coalesced: u64,
    pub dropped: u64,
}

impl Default for Coalescer {
    fn default() -> Self {
        Coalescer {
            map: HashMap::with_capacity(CAPACITY),
            known: HashSet::with_capacity(CAPACITY),
            foreground: None,
            global: 0,
            dragging: false,
            overflowed: false,
            pending: false,
            events_in: 0,
            coalesced: 0,
            dropped: 0,
        }
    }
}

impl Coalescer {
    /// The callback's whole job. Returns whether the event was kept.
    pub fn record(&mut self, event: u32, hwnd: Hwnd, object: i32, child: i32, time: u32) -> bool {
        use self::event as e;
        self.events_in += 1;
        let global = match event {
            e::DESKTOP_SWITCH => global::DESKTOP_SWITCH,
            e::SWITCH_START => global::SWITCH_START,
            e::SWITCH_END => global::SWITCH_END,
            _ => 0,
        };
        if global != 0 {
            self.global |= global;
            self.pending = true;
            return true;
        }
        // Only whole windows: carets, cursors, scroll bars and the like report other objects.
        if object != 0 || child != 0 || hwnd == 0 {
            self.dropped += 1;
            return false;
        }
        let known = self.known.contains(&hwnd);
        let flag = match event {
            e::FOREGROUND => {
                if self.foreground.is_some() {
                    self.coalesced += 1;
                }
                self.foreground = Some(hwnd);
                self.pending = true;
                return true;
            }
            e::DESTROY | e::HIDE if !known => 0,
            e::DESTROY => bit::DESTROYED,
            e::HIDE => bit::HIDDEN,
            e::SHOW => bit::SHOWN,
            e::CLOAKED => bit::CLOAKED,
            e::UNCLOAKED => bit::UNCLOAKED,
            e::MINIMIZE_START => bit::MIN_START,
            e::MINIMIZE_END => bit::MIN_END,
            e::MOVESIZE_START => {
                self.dragging = true;
                bit::MOVE_START
            }
            e::MOVESIZE_END => {
                self.dragging = false;
                bit::MOVE_END
            }
            e::LOCATION_CHANGE if self.dragging => 0,
            e::LOCATION_CHANGE => bit::LOCATED,
            _ => 0,
        };
        if flag == 0 {
            self.dropped += 1;
            return false;
        }
        let full = self.map.len() >= CAPACITY;
        match self.map.get_mut(&hwnd) {
            Some(delta) => {
                delta.bits |= flag;
                delta.last_ms = time;
                self.coalesced += 1;
            }
            None if full => {
                self.dropped += 1;
                self.overflowed = true;
                self.pending = true;
                return false;
            }
            None => {
                self.map.insert(
                    hwnd,
                    Delta {
                        bits: flag,
                        last_ms: time,
                    },
                );
            }
        }
        self.pending = true;
        true
    }

    /// Moves everything recorded into `batch`, keeping the map's room for the next burst.
    pub fn drain_into(&mut self, batch: &mut Batch) {
        batch.windows.clear();
        batch.windows.extend(self.map.drain());
        batch.foreground = self.foreground.take();
        batch.global = std::mem::take(&mut self.global);
        batch.overflowed = std::mem::take(&mut self.overflowed);
        self.pending = false;
    }

    pub fn know(&mut self, hwnd: Hwnd) {
        self.known.insert(hwnd);
    }

    pub fn forget(&mut self, hwnd: Hwnd) {
        self.known.remove(&hwnd);
    }

    #[cfg(test)]
    pub fn known_len(&self) -> usize {
        self.known.len()
    }
}

/// What the loop does about pending events after draining its messages.
#[derive(Debug, PartialEq, Eq)]
pub enum Plan {
    Idle,
    FlushNow,
    /// Arm the trailing timer for this long.
    FlushIn(Duration),
}

pub fn plan(pending: bool, now: Instant, last_flush: Option<Instant>) -> Plan {
    if !pending {
        return Plan::Idle;
    }
    match last_flush.map(|t| now.saturating_duration_since(t)) {
        Some(gap) if gap < MIN_GAP => Plan::FlushIn(MIN_GAP - gap),
        _ => Plan::FlushNow,
    }
}

#[cfg(test)]
mod tests {
    use super::event as e;
    use super::*;

    #[test]
    fn a_burst_about_one_window_is_one_entry() {
        let mut c = Coalescer::default();
        c.know(5);
        for t in 0..100 {
            c.record(e::LOCATION_CHANGE, 5, 0, 0, t);
        }
        c.record(e::SHOW, 5, 0, 0, 100);
        let mut batch = Batch::default();
        c.drain_into(&mut batch);
        assert_eq!(batch.windows.len(), 1);
        assert_eq!(batch.windows[0].1.bits, bit::LOCATED | bit::SHOWN);
        assert_eq!(batch.windows[0].1.last_ms, 100);
        assert_eq!((c.events_in, c.coalesced), (101, 100));
        assert!(!c.pending);
    }

    #[test]
    fn carets_and_unknown_windows_hiding_are_dropped() {
        let mut c = Coalescer::default();
        assert!(!c.record(e::LOCATION_CHANGE, 5, -8, 0, 1), "a caret");
        assert!(!c.record(e::SHOW, 5, 0, 3, 1), "a child element");
        assert!(!c.record(e::SHOW, 0, 0, 0, 1), "no window");
        assert!(!c.record(e::HIDE, 5, 0, 0, 1), "never seen");
        assert!(!c.record(e::DESTROY, 5, 0, 0, 1), "never seen");
        c.know(5);
        assert!(c.record(e::DESTROY, 5, 0, 0, 1));
        assert_eq!(c.dropped, 5);
    }

    #[test]
    fn no_location_changes_while_dragging() {
        let mut c = Coalescer::default();
        c.record(e::MOVESIZE_START, 7, 0, 0, 1);
        assert!(!c.record(e::LOCATION_CHANGE, 7, 0, 0, 2));
        c.record(e::MOVESIZE_END, 7, 0, 0, 3);
        assert!(c.record(e::LOCATION_CHANGE, 7, 0, 0, 4));
    }

    #[test]
    fn only_the_last_foreground_is_kept() {
        let mut c = Coalescer::default();
        c.record(e::FOREGROUND, 1, 0, 0, 1);
        c.record(e::FOREGROUND, 2, 0, 0, 2);
        c.record(e::DESKTOP_SWITCH, 0, 0, 0, 3);
        let mut batch = Batch::default();
        c.drain_into(&mut batch);
        assert_eq!(batch.foreground, Some(2));
        assert_eq!(batch.global, global::DESKTOP_SWITCH);
        assert!(batch.windows.is_empty());
    }

    #[test]
    fn the_map_keeps_its_room_after_a_flush() {
        let mut c = Coalescer::default();
        let room = c.map.capacity();
        for h in 1..=400 {
            c.record(e::SHOW, h, 0, 0, 1);
        }
        let mut batch = Batch::default();
        c.drain_into(&mut batch);
        assert_eq!(batch.windows.len(), 400);
        assert_eq!(c.map.capacity(), room, "nothing was allocated");
    }

    #[test]
    fn flushes_lead_then_trail_at_sixteen_ms() {
        let t0 = Instant::now();
        assert_eq!(plan(false, t0, None), Plan::Idle);
        assert_eq!(plan(true, t0, None), Plan::FlushNow);
        let soon = t0 + Duration::from_millis(5);
        assert_eq!(
            plan(true, soon, Some(t0)),
            Plan::FlushIn(Duration::from_millis(11))
        );
        assert_eq!(plan(true, t0 + MIN_GAP, Some(t0)), Plan::FlushNow);
    }

    #[test]
    fn a_full_map_drops_and_counts_rather_than_grow() {
        let mut c = Coalescer::default();
        let room = c.map.capacity();
        for h in 1..=CAPACITY as Hwnd + 10 {
            c.record(e::SHOW, h, 0, 0, 1);
        }
        assert_eq!(c.map.len(), CAPACITY);
        assert_eq!(c.map.capacity(), room, "nothing allocated");
        assert_eq!(c.dropped, 10);
        assert!(
            c.record(e::LOCATION_CHANGE, 1, 0, 0, 2),
            "a window already in it still counts"
        );
        let mut batch = Batch::default();
        c.drain_into(&mut batch);
        assert!(batch.overflowed);
        c.drain_into(&mut batch);
        assert!(!batch.overflowed, "only until the flush");
    }
}
