// One kill-test world: a private desktop, nook-testwin's windows on it with their state before
// anything touched them, a journal folder and a tag of its own for the shared objects. The live
// session's objects (tagged with the session id) and journal are never named.

use crate::desk::{Child, PrivateDesktop};
use crate::jobs::Job;
use crate::probe::{self, WinState};
use nook_restore::journal::{Loaded, Store};
use nook_restore::placement::Hwnd;
use std::path::PathBuf;
use std::time::Duration;

/// The version the test host journals; every restorer here is told the same one.
pub const VERSION: &str = "0.0.0-killtest";
/// nook-testwin's windows: 0 and 2 normal, 1 and 3 maximized.
pub const WINDOWS: usize = 4;
const LINE_WAIT: Duration = Duration::from_secs(20);

pub struct Exes {
    pub guard: PathBuf,
    pub testwin: PathBuf,
    pub host: PathBuf,
}

/// The programs under test. The guard is this crate's binary (or NOOK_GUARD_EXE, to measure a
/// release build); the test programs are examples, which `cargo build --examples` makes.
pub fn exes() -> Exes {
    let guard = std::env::var_os("NOOK_GUARD_EXE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_nook-guard")));
    let me = std::env::current_exe().expect("the test's own path");
    let examples = me
        .parent()
        .and_then(|deps| deps.parent())
        .expect("target/<profile>")
        .join("examples");
    let exes = Exes {
        guard,
        testwin: examples.join("nook-testwin.exe"),
        host: examples.join("nook-testhost.exe"),
    };
    for exe in [&exes.guard, &exes.testwin, &exes.host] {
        assert!(
            exe.exists(),
            "{} is missing: run `cargo build --examples` first",
            exe.display()
        );
    }
    exes
}

/// xorshift64*: enough randomness for kill points, and a run is replayed from its seed.
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed | 1)
    }

    pub fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 {
            0
        } else {
            self.next() % n
        }
    }

    pub fn coin(&mut self) -> bool {
        self.next() & 1 == 1
    }
}

pub struct Setup {
    pub testwin: Child,
    pub desk: PrivateDesktop,
    pub dir: PathBuf,
    pub tag: String,
    pub windows: Vec<(Hwnd, bool)>,
    pub baseline: Vec<WinState>,
}

impl Setup {
    pub fn new(exes: &Exes, label: &str, job: Job) -> Setup {
        let desk = PrivateDesktop::create(label, job);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("nook-kill-{pid}-{label}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the run's journal folder");
        let testwin = desk.spawn(
            &exes.testwin,
            &["--count=4".into(), "--maximized=1,3".into()],
        );
        let mut windows = Vec::new();
        while let Some(line) = testwin.wait_for(|_| true, LINE_WAIT) {
            if line == "ready" {
                break;
            }
            let mut words = line.split_whitespace();
            if let (Some("hwnd"), Some(hwnd), Some(state)) =
                (words.next(), words.next(), words.next())
            {
                let raw = usize::from_str_radix(hwnd.trim_start_matches("0x"), 16).unwrap();
                windows.push((Hwnd(raw as isize), state == "maximized"));
            }
        }
        assert_eq!(
            windows.len(),
            WINDOWS,
            "nook-testwin made its windows: {:?}",
            testwin.log()
        );
        // Showing and maximizing land asynchronously; the baseline waits for them.
        std::thread::sleep(Duration::from_millis(250));
        let hwnds: Vec<Hwnd> = windows.iter().map(|w| w.0).collect();
        let baseline = desk.on(move || probe::read(&hwnds));
        for (i, (state, (_, max))) in baseline.iter().zip(&windows).enumerate() {
            assert!(
                state.exists && state.visible && !state.iconic,
                "window {i}: {state:?}"
            );
            assert_eq!(state.zoomed, *max, "window {i} is as nook-testwin made it");
            assert_eq!(state.marker, None, "window {i} starts unmarked");
        }
        Setup {
            testwin,
            desk,
            dir,
            tag: format!("kill-{pid}-{label}"),
            windows,
            baseline,
        }
    }

    fn base_args(&self) -> Vec<String> {
        vec![
            format!("--dir={}", self.dir.display()),
            format!("--tag={}", self.tag),
        ]
    }

    /// The test host, driving this world's windows.
    pub fn host(&self, exes: &Exes, extra: &[String]) -> Child {
        let list: Vec<String> = self
            .windows
            .iter()
            .map(|(h, max)| format!("{h}:{}", if *max { "maximized" } else { "normal" }))
            .collect();
        let mut args = vec!["run".to_string()];
        args.extend(self.base_args());
        args.push(format!("--guard={}", exes.guard.display()));
        args.push(format!("--windows={}", list.join(",")));
        args.extend(extra.iter().cloned());
        self.desk.spawn(&exes.host, &args)
    }

    /// The host's next start: restores a dirty journal whose writer is gone.
    pub fn next_start(&self, exes: &Exes) -> Child {
        let mut args = vec!["start".to_string()];
        args.extend(self.base_args());
        self.desk.spawn(&exes.host, &args)
    }

    /// `--nook-restore-windows`, as the tray, the installer or a person would run it.
    pub fn cli(&self, exes: &Exes, wait_ms: u64, reason: &str) -> Child {
        let args = vec![
            "--nook-restore-windows".to_string(),
            format!("--reason={reason}"),
            format!("--nook-dir={}", self.dir.display()),
            format!("--nook-tag={}", self.tag),
            format!("--hearth-version={VERSION}"),
            format!("--wait-ms={wait_ms}"),
        ];
        self.desk.spawn(&exes.guard, &args)
    }

    pub fn read(&self) -> Vec<WinState> {
        let hwnds: Vec<Hwnd> = self.windows.iter().map(|w| w.0).collect();
        self.desk.on(move || probe::read(&hwnds))
    }

    /// Everything Nook left changed: in the windows, and in a journal that still owes a restore.
    /// With `keep_positions` (an update's restore) a window may stay where Nook put it.
    pub fn problems(&self, keep_positions: bool) -> Vec<String> {
        let now = self.read();
        let mut found: Vec<String> = self
            .baseline
            .iter()
            .zip(&now)
            .enumerate()
            .flat_map(|(i, (before, after))| probe::problems(i, before, after, keep_positions))
            .collect();
        match Store::in_dir(&self.dir).load() {
            Loaded::Found(journal) if journal.owes_restore() => found.push(format!(
                "the journal still owes a restore ({:?})",
                journal.state
            )),
            Loaded::Corrupt(why) => found.push(format!("the journal is unreadable: {why}")),
            _ => {}
        }
        found
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        // The windows go with their process; the desktop closes once nothing is left on it.
        self.testwin.process.kill();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
