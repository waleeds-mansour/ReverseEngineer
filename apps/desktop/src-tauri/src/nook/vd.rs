// Virtual desktops (docs/nook-wm.md, "STAGE D"), on nook-com: a single-threaded COM apartment
// that holds the documented IVirtualDesktopManager and answers one question per window, whether
// it is on the current virtual desktop. nook-wm never waits for it: it asks, carries on with the
// answer unknown (Stage B already leaves alone the windows Windows cloaks for other desktops),
// and folds the answer in when it arrives. An answer that takes longer than 500 ms marks the
// thread stuck, and nook-wm stops asking until it answers again.

use super::perf::Counters;
use super::probe::Hwnd;
use super::sync::{self, Handle, Woke};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    COINIT_DISABLE_OLE1DDE,
};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

pub const DEADLINE: Duration = Duration::from_millis(500);

/// One answer: Some(on this desktop) or None when Windows couldn't say.
pub type Answer = (Hwnd, Option<bool>);

pub struct Vd {
    queue: Mutex<VecDeque<Hwnd>>,
    wake: Handle,
    stop: AtomicBool,
    pub counters: Arc<Counters>,
}

impl Vd {
    pub fn new() -> std::io::Result<Arc<Vd>> {
        Ok(Arc::new(Vd {
            queue: Mutex::new(VecDeque::new()),
            wake: sync::event(None)?,
            stop: AtomicBool::new(false),
            counters: Arc::default(),
        }))
    }

    pub fn ask(&self, hwnds: impl IntoIterator<Item = Hwnd>) {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        let before = q.len();
        q.extend(hwnds);
        if q.len() > before {
            sync::set(&self.wake);
        }
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        sync::set(&self.wake);
    }

    fn take(&self) -> Vec<Hwnd> {
        let mut q = self.queue.lock().unwrap_or_else(|p| p.into_inner());
        q.drain(..).collect()
    }
}

/// nook-com's body. `answer` hands each batch to nook-wm.
pub fn run(vd: Arc<Vd>, answer: impl Fn(Vec<Answer>)) {
    let _here = vd.counters.here();
    let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
    let manager: Option<IVirtualDesktopManager> = if init.is_ok() {
        unsafe { CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL) }.ok()
    } else {
        None
    };
    loop {
        // An STA pumps while it waits, so COM's own calls into it are answered.
        let woke = sync::wait(&[vd.wake.raw()], None);
        Counters::bump(&vd.counters.wakeups);
        if woke == Woke::Message && !sync::pump() {
            break;
        }
        if vd.stop.load(Ordering::SeqCst) {
            break;
        }
        let asked = vd.take();
        if asked.is_empty() {
            continue;
        }
        let answers = asked
            .into_iter()
            .map(|h| {
                let on = manager.as_ref().and_then(|m| {
                    unsafe { m.IsWindowOnCurrentVirtualDesktop(super::window::hwnd(h)) }
                        .ok()
                        .map(|b| b.as_bool())
                });
                (h, on)
            })
            .collect();
        answer(answers);
    }
    drop(manager);
    if init.is_ok() {
        unsafe { CoUninitialize() };
    }
}

/// nook-wm's side: what it asked and when, so a stuck thread is noticed without waiting on it.
#[derive(Default)]
pub struct Asked {
    since: Option<Instant>,
    outstanding: usize,
    pub stuck: bool,
}

impl Asked {
    /// Whether to send more questions now.
    pub fn may_ask(&mut self, now: Instant) -> bool {
        if let Some(t) = self.since {
            if now.saturating_duration_since(t) >= DEADLINE {
                self.stuck = true;
            }
        }
        !self.stuck
    }

    pub fn sent(&mut self, n: usize, now: Instant) {
        if n > 0 {
            self.since.get_or_insert(now);
            self.outstanding += n;
        }
    }

    pub fn answered(&mut self, n: usize) {
        self.outstanding = self.outstanding.saturating_sub(n);
        self.stuck = false;
        if self.outstanding == 0 {
            self.since = None;
        }
    }

    /// When the oldest question runs out of time, so the loop can look then.
    pub fn deadline(&self) -> Option<Instant> {
        if self.stuck {
            None
        } else {
            self.since.map(|t| t + DEADLINE)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_slow_answer_marks_the_thread_stuck_until_it_answers() {
        let t0 = Instant::now();
        let mut a = Asked::default();
        assert!(a.may_ask(t0));
        a.sent(3, t0);
        assert_eq!(a.deadline(), Some(t0 + DEADLINE));
        assert!(a.may_ask(t0 + Duration::from_millis(100)));
        assert!(!a.may_ask(t0 + DEADLINE));
        assert!(a.stuck);
        assert_eq!(a.deadline(), None);
        a.answered(3);
        assert!(!a.stuck);
        assert!(a.may_ask(t0 + Duration::from_secs(5)));
    }

    // The test's thread has no windows to ask about, so it asks about a handle that isn't one.
    // On this PC's build the manager answers true even for that, so only the round trip is
    // checked here; the private-desktop test asks about real windows.
    #[test]
    fn the_com_thread_answers_and_stops() {
        let vd = Vd::new().unwrap();
        let (tx, rx) = mpsc::channel();
        let worker = {
            let vd = vd.clone();
            std::thread::spawn(move || run(vd, move |a| tx.send(a).unwrap()))
        };
        vd.ask([0x7FFF_0003_isize]);
        let got = rx.recv_timeout(Duration::from_secs(5)).expect("an answer");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, 0x7FFF_0003);
        vd.stop();
        worker.join().unwrap();
        assert!(vd.counters.snapshot().wakeups >= 2);
    }
}
