// The host's life: start the guard, run the steps while beating, then idle until something ends
// it. Like Hearth, it starts a new guard when its guard dies and answers a restore that someone
// asks for. With --stall-at it wedges instead, the way a stuck window manager thread would, and
// once a restorer revokes it, tries every write again so the test can count that none landed.

use crate::steps::{self, desktop_fail, journal_fail, Fail, Step};
use crate::VERSION;
use nook_restore::desktop::Desktop;
use nook_restore::guard::{self, spawn, spawn::Process};
use nook_restore::journal::{new_session_id, Journal, Store, Writer};
use nook_restore::objects::session::{Kind, SessionObjects};
use nook_restore::objects::Signals;
use nook_restore::placement::{Hwnd, Placement};
use nook_restore::recover::{boot_time_ms, now_ms, restore_all, Context};
use nook_restore::Clock;
use nook_restore::RealDesktop;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::System::Threading::{WaitForMultipleObjects, WaitForSingleObject};

pub struct Config {
    pub dir: PathBuf,
    pub tag: String,
    pub guard: PathBuf,
    pub windows: Vec<(Hwnd, bool)>,
    pub beat: Duration,
    pub step: Duration,
    pub until: Option<usize>,
    pub stall_at: Option<usize>,
    pub stall_delay: Duration,
}

/// One line for the test, written at once.
pub fn say(line: &str) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

struct Host {
    config: Config,
    store: Store,
    objects: Arc<SessionObjects>,
    reader: RealDesktop,
    journal: Journal,
    writer: Option<Writer>,
    wm: Option<RealDesktop>,
    guard: Option<Process>,
    bits: Vec<u32>,
}

pub fn run(config: Config, store: Store, objects: SessionObjects) {
    let me = spawn::this_process();
    let session = new_session_id(me.pid, me.start, u128::from(now_ms()));
    let journal = Journal::new(VERSION, session, me.pid, me.start, boot_time_ms(now_ms()));
    let mut host = Host {
        bits: vec![0; config.windows.len()],
        config,
        store,
        objects: Arc::new(objects),
        reader: RealDesktop::observing(),
        journal,
        writer: None,
        wm: None,
        guard: None,
    };
    let maximized: Vec<bool> = host.config.windows.iter().map(|w| w.1).collect();
    let plan = steps::plan(&maximized);
    say(&format!("plan {}", plan.len()));
    // Hearth clears an earlier restore's Done before it starts a guard for this run.
    host.objects.clear_done();
    host.launch_guard();
    for (n, step) in plan.iter().enumerate() {
        if host.config.until == Some(n) {
            break;
        }
        if host.config.stall_at == Some(n) {
            host.stall(n, &plan[n..], &steps::again(&maximized));
        }
        host.tend();
        say(&format!("step {n} {}", step.label()));
        match host.apply(*step) {
            Ok(()) => {}
            Err(Fail::Refused) => {
                say(&format!("revoked {n}"));
                std::process::exit(0);
            }
            Err(Fail::Other(e)) => say(&format!("error {n} {e}")),
        }
        if !host.config.step.is_zero() {
            std::thread::sleep(host.config.step);
        }
    }
    say("idle");
    host.idle();
}

impl Host {
    fn launch_guard(&mut self) {
        let mut options = guard::Options::new(spawn::this_process());
        options.nook_dir = Some(self.config.dir.clone());
        options.tag = Some(self.config.tag.clone());
        options.hearth_version = Some(VERSION.to_string());
        options.beat = self.config.beat;
        // A dead guard's handle stays signalled, so it is dropped before trying again.
        self.guard = None;
        match spawn::launch(&self.config.guard, &options) {
            Ok(process) => {
                say(&format!("guard {}", process.pid));
                self.guard = Some(process);
            }
            Err(e) => say(&format!("error guard {e}")),
        }
    }

    /// Between steps: beat, replace a dead guard, and answer a requested restore.
    fn tend(&mut self) {
        self.objects.pulse();
        if self.guard.as_ref().is_some_and(Process::has_exited) {
            self.launch_guard();
        }
        if self.objects.restore_requested() {
            self.answer();
        }
    }

    /// Puts everything back for whoever asked, as Hearth's window manager would, and ends.
    fn answer(&self) -> ! {
        let reason = self.objects.requested_reason();
        let mut ctx = Context::current(Some(VERSION.to_string()));
        // The writer is this process, which stopped writing to answer: no late pass to wait for.
        ctx.late_pass_after = None;
        let report = restore_all(
            &RealDesktop::restoring(),
            &self.store,
            self.objects.as_ref(),
            &ctx,
            reason,
        );
        say(&format!(
            "restored {} {}",
            report.restored,
            report.failed.len()
        ));
        std::process::exit(0);
    }

    fn write_journal(&mut self) -> Result<(), Fail> {
        let writer = self.writer.as_mut().ok_or(Fail::Refused)?;
        writer
            .write(self.objects.as_ref(), &mut self.journal, Clock::current())
            .map_err(journal_fail)
    }

    fn entry(&mut self, i: usize) -> Option<&mut nook_restore::journal::WindowEntry> {
        let hwnd = self.config.windows[i].0;
        self.journal.windows.iter_mut().find(|e| e.hwnd == hwnd)
    }

    /// The window manager's view, once it has claimed the journal.
    fn wm(&self) -> Result<&RealDesktop, Fail> {
        self.wm.as_ref().ok_or(Fail::Refused)
    }

    fn apply(&mut self, step: Step) -> Result<(), Fail> {
        match step {
            Step::Claim => {
                let store = self.store.clone();
                let signals = self.objects.as_ref();
                let writer = Writer::claim(store, signals, &mut self.journal, Clock::current())
                    .map_err(journal_fail)?;
                let signals: Arc<dyn Signals> = self.objects.clone();
                self.wm = Some(RealDesktop::managing(signals, writer.epoch()));
                self.writer = Some(writer);
                Ok(())
            }
            Step::Arm => {
                self.objects.arm();
                Ok(())
            }
            Step::Adopt(i) => {
                let hwnd = self.config.windows[i].0;
                if self.entry(i).is_none() {
                    let entry = steps::entry_for(&self.reader, hwnd)?;
                    self.journal.windows.push(entry);
                }
                self.write_journal()
            }
            Step::Mark(i, bit) => {
                self.bits[i] |= bit;
                let hwnd = self.config.windows[i].0;
                self.wm()?
                    .set_marker(hwnd, self.bits[i])
                    .map_err(desktop_fail)
            }
            Step::PlanMove(i, rect) => {
                if let Some(entry) = self.entry(i) {
                    entry.last_set = Some(rect);
                }
                self.write_journal()
            }
            Step::Move(i, rect) => {
                let hwnd = self.config.windows[i].0;
                let target = Placement::normal(rect).quiet();
                self.wm()?
                    .set_placement(hwnd, &target)
                    .map_err(desktop_fail)
            }
            Step::PlanBorder(i) => {
                if let Some(entry) = self.entry(i) {
                    entry.border_set = true;
                }
                self.write_journal()
            }
            Step::Border(i) => {
                let hwnd = self.config.windows[i].0;
                self.wm()?
                    .set_border_color(hwnd, steps::BORDER)
                    .map_err(desktop_fail)
            }
            Step::PlanHide(i) => {
                let hwnd = self.config.windows[i].0;
                let before = self.reader.placement(hwnd);
                if let (Some(before), Some(entry)) = (before, self.entry(i)) {
                    steps::plan_hide(entry, before);
                }
                self.write_journal()
            }
            Step::Hide(i) => {
                let hwnd = self.config.windows[i].0;
                let before = self.entry(i).and_then(|e| e.hide_placement);
                let before = before.or_else(|| self.reader.placement(hwnd));
                let before = before.ok_or(Fail::Other("can't read the placement".into()))?;
                let target = steps::hidden_from(before);
                self.wm()?
                    .set_placement(hwnd, &target)
                    .map_err(desktop_fail)
            }
        }
    }

    /// After the last step: beat, replace a dead guard, answer a requested restore, and stop
    /// once revoked. Waits on the events between beats, so it reacts at once.
    fn idle(&mut self) -> ! {
        let beat = (self.config.beat / 3).max(Duration::from_millis(10));
        let ms = beat.as_millis().min(60_000) as u32;
        loop {
            self.objects.pulse();
            let mut handles: Vec<HANDLE> = vec![self.objects.handle(Kind::Restore)];
            if let Some(guard) = &self.guard {
                handles.push(guard.handle());
            }
            if let Some(writer) = &self.writer {
                if self.objects.is_revoked(writer.epoch()) {
                    say("revoked idle");
                    std::process::exit(0);
                }
                handles.push(self.objects.handle(Kind::Revoked));
            }
            let woke = unsafe { WaitForMultipleObjects(&handles, false, ms) };
            if woke == WAIT_OBJECT_0 {
                self.answer();
            }
            if self.guard.as_ref().is_some_and(Process::has_exited) {
                self.launch_guard();
            }
        }
    }

    /// Wedges at step `n`: no beat, no answer, until a restorer revokes this writer. Then it
    /// tries the rest of the plan and every change once more, and reports how many landed.
    fn stall(&mut self, n: usize, rest: &[Step], again: &[Step]) -> ! {
        say(&format!("stall {n}"));
        let revoked = self.objects.handle(Kind::Revoked);
        let got = unsafe { WaitForSingleObject(revoked, 120_000) };
        if got != WAIT_OBJECT_0 {
            say("error stall never revoked");
            std::process::exit(4);
        }
        if !self.config.stall_delay.is_zero() {
            std::thread::sleep(self.config.stall_delay);
        }
        let (mut ok, mut refused, mut other) = (0, 0, 0);
        for step in rest.iter().chain(again) {
            match self.apply(*step) {
                Ok(()) => ok += 1,
                Err(Fail::Refused) => refused += 1,
                Err(Fail::Other(e)) => {
                    other += 1;
                    say(&format!("error after-stall {} {e}", step.label()));
                }
            }
        }
        say(&format!(
            "after-stall ok={ok} refused={refused} other={other}"
        ));
        std::process::exit(0);
    }
}
