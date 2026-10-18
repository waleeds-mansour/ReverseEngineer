// What Nook costs, measured from inside (docs/nook-wm.md, "MEASUREMENT"). hearth.exe already
// wakes about 110 times a second from handy-keys, so per-process counters can't show Nook's
// share. Each Nook thread counts its own wakeups and work instead, and QueryThreadCycleTime gives
// each thread's CPU. The owner's perf script (apps/desktop/scripts/nook-perf.ps1) sets a named
// event, and nook-wm answers by writing diag.json next to nook.log; nothing leaves the PC.

use serde::Serialize;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Duration;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{
    GetCurrentProcessId, GetProcessIdOfThread, OpenThread, THREAD_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::WindowsProgramming::QueryThreadCycleTime;

/// The export, in Nook's folder.
pub const EXPORT_FILE: &str = "diag.json";
/// The event the perf script sets, per session: Local\Nook.Diag.<session id>.
pub fn export_event_name(session: &str) -> String {
    format!(r"Local\Nook.Diag.{session}")
}

/// Each power of two is split into this many equal buckets, so a quantile is known to within
/// an eighth: the 5 µs callback budget falls on a bucket edge (5120 ns) rather than inside one.
const SPLIT: u32 = 8;
const BUCKETS: usize = 40 * SPLIT as usize;

/// Durations in log-linear nanosecond buckets.
#[derive(Clone, Debug, Serialize)]
pub struct Histogram {
    #[serde(skip)]
    buckets: Box<[u64; BUCKETS]>,
}

impl Default for Histogram {
    fn default() -> Self {
        Histogram {
            buckets: Box::new([0; BUCKETS]),
        }
    }
}

/// The bucket for `ns`: below 8 ns one per nanosecond, then eight per power of two.
fn bucket(ns: u64) -> usize {
    if ns < u64::from(SPLIT) {
        return ns as usize;
    }
    let e = 63 - ns.leading_zeros();
    let sub = (ns >> (e - 3)) & u64::from(SPLIT - 1);
    ((e - 2) * SPLIT + sub as u32).min(BUCKETS as u32 - 1) as usize
}

/// The exclusive upper bound, in ns, of bucket `i`.
fn upper(i: usize) -> u64 {
    let i = i as u32;
    if i < SPLIT {
        return u64::from(i) + 1;
    }
    let e = i / SPLIT + 2;
    let sub = u64::from(i % SPLIT);
    (u64::from(SPLIT) + sub + 1) << (e - 3)
}

impl Histogram {
    pub fn add(&mut self, d: Duration) {
        let ns = u64::try_from(d.as_nanos()).unwrap_or(u64::MAX);
        self.buckets[bucket(ns)] += 1;
    }

    pub fn count(&self) -> u64 {
        self.buckets.iter().sum()
    }

    /// The upper bound, in ns, of the bucket holding the q-th quantile; 0 when empty.
    pub fn quantile_ns(&self, q: f64) -> u64 {
        let total = self.count();
        if total == 0 {
            return 0;
        }
        let want = ((total as f64) * q).ceil().max(1.0) as u64;
        let mut seen = 0;
        for (n, c) in self.buckets.iter().enumerate() {
            seen += c;
            if seen >= want {
                return upper(n);
            }
        }
        upper(BUCKETS - 1)
    }

    pub fn summary(&self) -> Summary {
        Summary {
            count: self.count(),
            p50_ns: self.quantile_ns(0.5),
            p99_ns: self.quantile_ns(0.99),
            max_ns: self.quantile_ns(1.0),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Summary {
    pub count: u64,
    /// Upper bounds of their buckets, each within an eighth of a power of two: a p99 of 5120
    /// means under 5.12 µs.
    pub p50_ns: u64,
    pub p99_ns: u64,
    pub max_ns: u64,
}

/// One thread's counters, shared so nook-wm can read the other threads' at export time.
#[derive(Debug, Default)]
pub struct Counters {
    pub tid: AtomicU32,
    /// Returns from the thread's wait: the number its wakeup budget counts.
    pub wakeups: AtomicU64,
    pub messages: AtomicU64,
    pub events_in: AtomicU64,
    pub coalesced: AtomicU64,
    pub dropped: AtomicU64,
    pub flushes: AtomicU64,
    pub commands: AtomicU64,
}

/// The thread's id stays in its counters while this lives; dropping it, when the thread's body
/// returns or unwinds, clears it, so an export never reads a thread that reused the id.
#[must_use = "the thread's id is cleared when this drops"]
pub struct Here<'a>(&'a Counters);

impl Drop for Here<'_> {
    fn drop(&mut self) {
        self.0.tid.store(0, Ordering::Relaxed);
    }
}

impl Counters {
    /// Called first thing on the thread the counters belong to, and kept until its body ends.
    pub fn here(&self) -> Here<'_> {
        let tid = unsafe { windows::Win32::System::Threading::GetCurrentThreadId() };
        self.tid.store(tid, Ordering::Relaxed);
        Here(self)
    }

    pub fn bump(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> ThreadSnapshot {
        let tid = self.tid.load(Ordering::Relaxed);
        let get = |c: &AtomicU64| c.load(Ordering::Relaxed);
        ThreadSnapshot {
            tid,
            cycles: cycles(tid),
            wakeups: get(&self.wakeups),
            messages: get(&self.messages),
            events_in: get(&self.events_in),
            coalesced: get(&self.coalesced),
            dropped: get(&self.dropped),
            flushes: get(&self.flushes),
            commands: get(&self.commands),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ThreadSnapshot {
    pub tid: u32,
    /// CPU cycles the thread has used, or None when it has ended.
    pub cycles: Option<u64>,
    pub wakeups: u64,
    pub messages: u64,
    pub events_in: u64,
    pub coalesced: u64,
    pub dropped: u64,
    pub flushes: u64,
    pub commands: u64,
}

/// QueryThreadCycleTime for a thread of this process, by id. An id another process's thread has
/// since been given reads as None.
pub fn cycles(tid: u32) -> Option<u64> {
    if tid == 0 {
        return None;
    }
    let h = unsafe { OpenThread(THREAD_QUERY_LIMITED_INFORMATION, false, tid) }.ok()?;
    let ours = unsafe { GetProcessIdOfThread(h) == GetCurrentProcessId() };
    let mut cycles = 0u64;
    let ok = ours && unsafe { QueryThreadCycleTime(h, &mut cycles) }.is_ok();
    unsafe {
        let _ = CloseHandle(h);
    }
    ok.then_some(cycles)
}

/// Writes `value` as diag.json in `dir`, replacing the last one whole.
pub fn write_export(dir: &Path, value: &impl Serialize) -> io::Result<std::path::PathBuf> {
    std::fs::create_dir_all(dir)?;
    let text = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    let path = dir.join(EXPORT_FILE);
    let tmp = dir.join(format!("{EXPORT_FILE}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_come_from_log_linear_buckets() {
        let mut h = Histogram::default();
        for _ in 0..99 {
            h.add(Duration::from_nanos(900));
        }
        h.add(Duration::from_micros(20));
        let s = h.summary();
        assert_eq!(s.count, 100);
        assert_eq!(s.p50_ns, 960, "900 ns sits in [896, 960)");
        assert_eq!(s.p99_ns, 960);
        assert_eq!(s.max_ns, 20480, "20 µs sits in [18432, 20480)");
        assert_eq!(Histogram::default().summary().p99_ns, 0);
    }

    #[test]
    fn every_duration_is_under_its_buckets_bound_and_not_far_under() {
        for ns in (0..20_000u64).chain([5_000, 5_119, 5_120, 1 << 40, u64::MAX]) {
            let i = bucket(ns);
            assert!(ns < upper(i) || i == BUCKETS - 1, "{ns} in {i}");
            if ns >= 8 && i < BUCKETS - 1 {
                assert!(upper(i) - ns <= upper(i) / 8, "{ns} is within an eighth");
            }
        }
        assert_eq!(upper(bucket(5_000)), 5_120);
        assert_eq!(upper(bucket(5_120)), 5_632);
    }

    #[test]
    fn this_threads_cycles_can_be_read_and_grow() {
        let c = Counters::default();
        let here = c.here();
        let before = c.snapshot().cycles.expect("this thread's cycles");
        assert!(before > 0);
        // Reading the counters is itself work, so a later reading is never smaller.
        std::thread::sleep(Duration::from_millis(1));
        assert!(c.snapshot().cycles.unwrap() >= before);
        assert_eq!(cycles(0), None);
        drop(here);
        assert_eq!(c.snapshot().tid, 0, "cleared when the body ends");
        assert_eq!(c.snapshot().cycles, None);
    }

    #[test]
    fn the_export_replaces_the_last_one() {
        let tmp = tempfile::tempdir().unwrap();
        write_export(tmp.path(), &serde_json::json!({"n": 1})).unwrap();
        let path = write_export(tmp.path(), &serde_json::json!({"n": 2})).unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(text.contains("\"n\": 2"));
        assert!(!tmp.path().join("diag.json.tmp").exists());
    }
}
