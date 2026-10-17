// The two clocks the journal records. The wall clock dates things for people and for safe start.
// Windows' tick count tells boots apart: it only ever goes back to zero when Windows starts, while
// the wall clock (and so "now minus uptime") moves whenever it is corrected, by a time sync, by
// hand or on resume.

use std::time::{SystemTime, UNIX_EPOCH};

/// When something is written: the wall clock in unix ms and Windows' tick count in ms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clock {
    pub now_ms: u64,
    pub ticks_ms: u64,
}

impl Clock {
    pub fn current() -> Clock {
        Clock {
            now_ms: now_ms(),
            ticks_ms: ticks_ms(),
        }
    }
}

pub fn now_ms() -> u64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    since.as_millis() as u64
}

/// GetTickCount64: milliseconds since Windows started, time asleep included.
#[cfg(windows)]
pub fn ticks_ms() -> u64 {
    unsafe { windows::Win32::System::SystemInformation::GetTickCount64() }
}

/// Nook writes no journal outside Windows; zero reads every journal as this boot's, which is the
/// harmless answer (the identity check still guards every write).
#[cfg(not(windows))]
pub fn ticks_ms() -> u64 {
    0
}

/// When Windows started, in unix ms. Only for people reading the journal: it moves with every
/// clock correction, so it never decides anything.
pub fn boot_time_ms(now: u64) -> u64 {
    now.saturating_sub(ticks_ms())
}
