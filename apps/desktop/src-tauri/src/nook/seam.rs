// The one door every write to another app's window goes through (docs/nook-wm.md, "OPT-IN
// FLOW"). It wraps nook-restore's RealDesktop, whose every write first asks Desktop::check, and
// counts each write that was tried, refused and landed. While observing, the desktop's mode is
// Observing, so check refuses every write with Err(ReadOnly) before any Win32 call: P1's exit
// criterion is that `landed` stays at zero, and the perf script reads it from diag.json.

use super::view::WriteCounts;
use nook_restore::desktop::{Desktop, DesktopError, Mode};
use nook_restore::RealDesktop;
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Default)]
struct Counts {
    attempted: AtomicU64,
    refused: AtomicU64,
    landed: AtomicU64,
}

pub struct Writer<D: Desktop = RealDesktop> {
    // Only `write` reaches it, and in P1 nothing writes, which is the point; P2's placement is the
    // first caller.
    #[cfg_attr(not(test), allow(dead_code))]
    desktop: D,
    counts: Counts,
}

impl Writer<RealDesktop> {
    /// The observer's writer: every write is refused.
    pub fn observing() -> Writer<RealDesktop> {
        Writer::over(RealDesktop::observing())
    }
}

impl<D: Desktop> Writer<D> {
    pub fn over(desktop: D) -> Writer<D> {
        Writer {
            desktop,
            counts: Counts::default(),
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn mode(&self) -> Mode {
        self.desktop.mode()
    }

    /// Runs one write through the seam and counts what came of it.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn write<T>(
        &self,
        op: impl FnOnce(&D) -> Result<T, DesktopError>,
    ) -> Result<T, DesktopError> {
        self.counts.attempted.fetch_add(1, Ordering::Relaxed);
        let result = op(&self.desktop);
        let counter = match &result {
            Ok(_) => &self.counts.landed,
            Err(_) => &self.counts.refused,
        };
        counter.fetch_add(1, Ordering::Relaxed);
        result
    }

    pub fn counts(&self) -> WriteCounts {
        WriteCounts {
            attempted: self.counts.attempted.load(Ordering::Relaxed),
            refused: self.counts.refused.load(Ordering::Relaxed),
            landed: self.counts.landed.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nook_restore::{Hwnd, Placement};

    // The handles are made up and never reach Windows: Observing refuses before any call, and
    // a test that saw a write land would fail right there.
    #[test]
    fn observing_refuses_every_write_before_windows_sees_it() {
        let w = Writer::observing();
        assert_eq!(w.mode(), Mode::Observing);
        let hwnd = Hwnd(0x7FFF_0001);
        let results = [
            w.write(|d| d.set_placement(hwnd, &Placement::default())),
            w.write(|d| d.show_no_activate(hwnd)),
            w.write(|d| d.uncloak(hwnd)),
            w.write(|d| d.set_marker(hwnd, 1)),
            w.write(|d| d.remove_marker(hwnd)),
            w.write(|d| d.set_border_color(hwnd, 0x00FF_0000)),
            w.write(|d| d.set_transitions_disabled(hwnd, true)),
            w.write(|d| d.remove_appbar(hwnd)),
        ];
        for r in results {
            assert_eq!(r, Err(DesktopError::ReadOnly));
        }
        assert_eq!(
            w.counts(),
            WriteCounts {
                attempted: 8,
                refused: 8,
                landed: 0
            }
        );
    }

    #[test]
    fn nothing_tried_means_nothing_counted() {
        assert_eq!(Writer::observing().counts(), WriteCounts::default());
    }
}
