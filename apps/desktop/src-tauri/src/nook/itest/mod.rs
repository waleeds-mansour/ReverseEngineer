// Nook's tests against real windows, every one on a private desktop of the test's own (desk.rs).
// The windows belong to a child process the test starts there (child.rs); nothing here reads,
// hooks or touches a window of the owner's. The probe the tests use (Guarded) answers only about
// the children's windows and fails the test if anything asks to open another process.

mod child;
mod desk;
mod experiments;
mod verdicts;
mod watch;

use super::monitors::Monitor;
use super::probe::{Closed, Hwnd, Probe, ProcessFacts, WindowFacts};
use super::sync;
use super::window::{self, RealProbe};
use desk::{Child, PrivateDesktop};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The window host, as the harness names it.
const HOST_TEST: &str = "nook::itest::child::window_host";

/// The windows a host announced, in order, as (kind, handle).
pub type Announced = Vec<(String, Hwnd)>;

/// Starts the window host on `desk` with `plan` (see child.rs).
pub fn host(desk: &PrivateDesktop, plan: &str) -> Child {
    let exe = std::env::current_exe().expect("the test binary");
    desk.spawn(
        &exe,
        &[
            HOST_TEST,
            "--exact",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
            "-q",
        ],
        &[(child::DESK_VAR, desk.name()), (child::PLAN_VAR, plan)],
    )
}

/// Reads the host's lines until `until`, dispatching this thread's messages meanwhile so the
/// hooks' callbacks run. It waits in short sleeps that also end on a message, never spinning.
pub fn follow(child: &Child, until: &str, timeout: Duration, seen: &mut Announced) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        let _ = sync::wait(&[], Some(Duration::from_millis(20)));
        sync::pump();
        while let Some(line) = child.try_line() {
            let Some(rest) = line.strip_prefix(child::TAG).map(str::trim) else {
                continue;
            };
            if let Some(h) = rest.strip_prefix("hwnd ") {
                let (kind, hex) = h.split_once(' ').expect("hwnd <kind> <handle>");
                let hwnd = Hwnd::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap();
                seen.push((kind.to_string(), hwnd));
            }
            if rest == until {
                return true;
            }
        }
    }
    false
}

/// Dispatches messages for `d`, so callbacks queued meanwhile run.
pub fn pump_for(d: Duration) {
    let deadline = Instant::now() + d;
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        let _ = sync::wait(&[], Some(left.min(Duration::from_millis(50))));
        sync::pump();
    }
}

/// The real probe, limited to the test's own children: other windows read as gone, and opening
/// any other process fails the test.
#[derive(Clone, Default)]
pub struct Guarded {
    pub pids: Arc<Mutex<HashSet<u32>>>,
    pub opened: Arc<Mutex<Vec<u32>>>,
}

impl Guarded {
    pub fn allow(&self, pid: u32) {
        self.pids.lock().unwrap().insert(pid);
    }

    fn ours(&self, hwnd: Hwnd) -> bool {
        let pid = window::pid_of(hwnd);
        pid != 0 && self.pids.lock().unwrap().contains(&pid)
    }

    pub fn opens(&self) -> usize {
        self.opened.lock().unwrap().len()
    }
}

impl Probe for Guarded {
    fn window(&self, hwnd: Hwnd) -> Option<WindowFacts> {
        self.ours(hwnd).then(|| RealProbe.window(hwnd)).flatten()
    }

    fn cloaked(&self, hwnd: Hwnd) -> Option<u32> {
        self.ours(hwnd).then(|| RealProbe.cloaked(hwnd)).flatten()
    }

    fn process(&self, pid: u32) -> Result<ProcessFacts, Closed> {
        assert!(
            self.pids.lock().unwrap().contains(&pid),
            "asked to open process {pid}, which isn't one of the test's"
        );
        self.opened.lock().unwrap().push(pid);
        RealProbe.process(pid)
    }

    fn uwp_child_pid(&self, frame: Hwnd) -> Option<u32> {
        self.ours(frame)
            .then(|| RealProbe.uwp_child_pid(frame))
            .flatten()
    }

    fn title(&self, hwnd: Hwnd) -> Option<String> {
        self.ours(hwnd).then(|| RealProbe.title(hwnd)).flatten()
    }

    fn monitors(&self) -> Vec<Monitor> {
        RealProbe.monitors()
    }

    fn top_level(&self) -> Vec<Hwnd> {
        let all = RealProbe.top_level();
        all.into_iter().filter(|&h| self.ours(h)).collect()
    }

    fn foreground(&self) -> Option<Hwnd> {
        RealProbe.foreground().filter(|&h| self.ours(h))
    }

    fn notification_state(&self) -> Option<i32> {
        RealProbe.notification_state()
    }

    fn input_desktop_ours(&self) -> bool {
        RealProbe.input_desktop_ours()
    }

    fn remote_session(&self) -> bool {
        RealProbe.remote_session()
    }

    fn description(&self, path: &str) -> Option<String> {
        RealProbe.description(path)
    }
}
