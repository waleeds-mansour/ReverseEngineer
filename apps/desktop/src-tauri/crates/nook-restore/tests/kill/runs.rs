// One kill run's machinery (docs/nook-wm.md, "Kill tests"): a private desktop with test windows,
// the host driving them, the guards it starts and the restorers the run adds, read line by line.
// Every run ends with the same check: no test window minimized, moved, hidden, cloaked,
// recoloured or marked, a journal that owes nothing, and no restorer that reported a failed write.

use crate::desk::Child;
use crate::jobs::Job;
use crate::procs::{Proc, KILLED};
use crate::setup::{Exes, Rng, Setup};
use std::time::{Duration, Instant};

const LINE_WAIT: Duration = Duration::from_secs(20);
const END_WAIT: Duration = Duration::from_secs(25);

pub struct Outcome {
    pub scenario: &'static str,
    pub detail: String,
    pub kill_label: Option<String>,
    pub problems: Vec<String>,
    pub notes: Vec<String>,
    pub guard_codes: Vec<Option<u32>>,
    /// Whether DWM reported the test windows' border colour, so recolouring was read back.
    pub border_checked: bool,
    /// Whether DWM reported the test windows' cloaked state, so cloaking was read back.
    pub cloak_checked: bool,
    pub log: Vec<String>,
}

pub struct Run<'a> {
    exes: &'a Exes,
    pub world: Setup,
    pub host: Child,
    pub guards: Vec<Proc>,
    extra: Vec<Child>,
    pub notes: Vec<String>,
    pub problems: Vec<String>,
    pub plan: usize,
    /// The exit code the host is ended with when the run kills it: the harness's own, or 1 for
    /// taskkill /F.
    pub host_kill_code: u32,
    /// The run's restore keeps positions (an update's), so a window may stay where Nook put it.
    pub keep_positions: bool,
    last_label: Option<String>,
}

impl<'a> Run<'a> {
    pub fn start(exes: &'a Exes, label: &str, host_args: &[String]) -> Run<'a> {
        Run::start_in(exes, label, host_args, Job::Strict)
    }

    pub fn start_in(exes: &'a Exes, label: &str, host_args: &[String], job: Job) -> Run<'a> {
        let world = Setup::new(exes, label, job);
        let host = world.host(exes, host_args);
        let mut run = Run {
            exes,
            world,
            host,
            guards: Vec::new(),
            extra: Vec::new(),
            notes: Vec::new(),
            problems: Vec::new(),
            plan: 0,
            host_kill_code: KILLED,
            keep_positions: false,
            last_label: None,
        };
        let plan = run.next(|l| l.starts_with("plan "));
        run.plan = plan
            .and_then(|l| l[5..].parse().ok())
            .expect("the host says how many steps it has");
        if !run.wait_guards(1) {
            run.problems.push("the host started no guard".into());
        }
        run
    }

    /// The next host line `want` accepts. Every line on the way is looked at, so a guard the host
    /// starts is always opened, whatever the run is waiting for.
    pub fn next(&mut self, want: impl Fn(&str) -> bool) -> Option<String> {
        self.next_within(LINE_WAIT, want)
    }

    /// As `next`, for a line that may take longer than LINE_WAIT, like one that waits on the
    /// guard noticing missed beats.
    pub fn next_within(&mut self, wait: Duration, want: impl Fn(&str) -> bool) -> Option<String> {
        let until = Instant::now() + wait;
        loop {
            let left = until.checked_duration_since(Instant::now())?;
            let line = self.host.wait_for(|_| true, left)?;
            if let Some(pid) = line.strip_prefix("guard ") {
                match pid.parse().ok().and_then(Proc::open_guard) {
                    Some(guard) => self.guards.push(guard),
                    None => self.notes.push(format!("couldn't open guard {pid}")),
                }
            } else if line.starts_with("revoked") || line.starts_with("error") {
                self.notes.push(format!("host: {line}"));
            }
            if want(&line) {
                return Some(line);
            }
        }
    }

    /// Waits until the host has started `count` guards in all.
    pub fn wait_guards(&mut self, count: usize) -> bool {
        while self.guards.len() < count {
            if self.next(|l| l.starts_with("guard ")).is_none() {
                break;
            }
        }
        self.guards.len() >= count
    }

    /// Waits for the host to start step `k` (or to go idle, for k at the plan's end).
    pub fn reach(&mut self, k: usize) -> bool {
        let step = format!("step {k} ");
        let line = if k >= self.plan {
            self.next(|l| l == "idle")
        } else {
            self.next(|l| l.starts_with(&step))
        };
        self.last_label = Some(match &line {
            Some(l) if k < self.plan => l[step.len()..].to_string(),
            Some(_) => "idle".to_string(),
            None => "host ended first".to_string(),
        });
        if line.is_none() {
            self.notes.push(format!("the host ended before step {k}"));
        }
        line.is_some()
    }

    /// Names where the run's kill or stall landed, for the summary.
    pub fn set_label(&mut self, label: &str) {
        self.last_label = Some(label.to_string());
    }

    pub fn kill_host(&self) {
        self.host.process.kill();
    }

    /// Kills the newest guard; false if it had already ended.
    pub fn kill_guard(&self) -> bool {
        match self.guards.last() {
            Some(guard) if guard.alive() => {
                guard.kill();
                true
            }
            _ => false,
        }
    }

    pub fn jitter(rng: &mut Rng) {
        std::thread::sleep(Duration::from_millis(rng.below(8)));
    }

    /// The restore that runs once nothing of Nook is left: the next start or the CLI.
    pub fn after_both(&mut self, rng: &mut Rng) {
        if rng.coin() {
            let start = self.world.next_start(self.exes);
            if let Some(line) = start.wait_for(|l| l.starts_with("start "), END_WAIT) {
                if let Some(counts) = line.strip_prefix("start ") {
                    self.check_restored(counts);
                }
                self.notes.push(line);
            }
            self.extra.push(start);
        } else {
            let wait = if rng.coin() { 0 } else { 300 };
            self.notes.push(format!("cli wait {wait}"));
            self.extra.push(self.world.cli(self.exes, wait, "user"));
        }
    }

    /// Reads a `restored R F` report and counts any window the restorer couldn't put back as a
    /// problem. A write DWM refuses shows up here even where the window can't be read back.
    pub fn check_restored(&mut self, line: &str) {
        let mut words = line.split_whitespace();
        if words.next() != Some("restored") {
            return;
        }
        match words.nth(1).and_then(|f| f.parse::<u32>().ok()) {
            Some(0) => {}
            Some(f) => self
                .problems
                .push(format!("a restorer couldn't put {f} windows back: {line}")),
            None => self.problems.push(format!("an unreadable report: {line}")),
        }
    }

    pub fn cli(&mut self, wait_ms: u64) {
        self.extra.push(self.world.cli(self.exes, wait_ms, "user"));
    }

    /// The CLI as the installer runs it before an update: everything shown, positions kept.
    pub fn cli_update(&mut self, wait_ms: u64) {
        self.keep_positions = true;
        self.extra
            .push(self.world.cli(self.exes, wait_ms, "update"));
    }

    /// Waits for every process of the run to end, then for the last asynchronous placements to
    /// land, and checks the windows, the journal and how each restorer ended.
    pub fn finish(mut self, scenario: &'static str, detail: String) -> Outcome {
        if !self.host.process.wait(END_WAIT) {
            self.notes.push("the host was still running".into());
            self.host.process.kill();
        }
        for guard in &self.guards {
            if !guard.wait(END_WAIT) {
                self.problems
                    .push(format!("guard {} never ended", guard.pid));
                guard.kill();
            }
        }
        for child in &self.extra {
            if !child.process.wait(END_WAIT) {
                self.problems.push("a restorer never ended".into());
                child.process.kill();
            }
        }
        // A guard, the CLI or a next start that ends with anything but 0 (or the test's kill)
        // either couldn't put a window back or broke; the host is held to the same.
        let ended = |name: String, code: Option<u32>| match code {
            Some(0) | Some(KILLED) | None => None,
            Some(c) => Some(format!("{name} ended with {c}")),
        };
        let mut codes: Vec<String> = Vec::new();
        let host_code = self.host.process.exit_code();
        if host_code != Some(self.host_kill_code) {
            codes.extend(ended("the host".into(), host_code));
        }
        for guard in &self.guards {
            codes.extend(ended(format!("guard {}", guard.pid), guard.exit_code()));
        }
        for child in &self.extra {
            let name = format!("restorer {}", child.process.pid);
            codes.extend(ended(name, child.process.exit_code()));
        }
        self.problems.extend(codes);
        std::thread::sleep(Duration::from_millis(400));
        let mut problems = std::mem::take(&mut self.problems);
        problems.extend(self.world.problems(self.keep_positions));
        let mut log = self.host.log();
        for child in &self.extra {
            log.extend(child.log());
        }
        let baseline = &self.world.baseline;
        Outcome {
            scenario,
            detail,
            kill_label: self.last_label.clone(),
            guard_codes: self.guards.iter().map(Proc::exit_code).collect(),
            border_checked: baseline.iter().all(|w| w.border.is_some()),
            cloak_checked: baseline.iter().all(|w| w.cloaked.is_some()),
            problems,
            notes: std::mem::take(&mut self.notes),
            log,
        }
    }
}

impl Drop for Run<'_> {
    fn drop(&mut self) {
        for guard in &self.guards {
            guard.kill();
        }
        for child in &self.extra {
            child.process.kill();
        }
        self.host.process.kill();
    }
}
