// The gates' side of nook-wm's state (docs/nook-wm.md, "GATES"): the game guard on every
// foreground change, what nook-shell hears, settles and missing monitors, and nook.log's line for
// each gate that trips or clears. Also the small exchanges with nook-com and the hook set: the
// virtual-desktop questions, the windows the callback knows, and the process F1 follows.

use super::super::diag::{self, Event};
use super::super::eligibility::{Kind, Stage};
use super::super::game;
use super::super::gates::{Act, Gates, MISSING_FOR};
use super::super::monitors::holding;
use super::super::probe::{Hwnd, Probe};
use super::super::shell::Signal;
use super::super::vd::Answer;
use super::super::why::Why;
use super::state::Wm;
use std::time::Instant;

impl<P: Probe> Wm<P> {
    pub fn judge_game(&mut self, now: Instant) {
        let probe = &self.probe;
        let quns = self.quns.get(now, || probe.notification_state());
        let front = self.focused.and_then(|h| self.windows.get(&h));
        let tripped = front.and_then(|w| {
            let f = &w.v.facts;
            // A game off every monitor (minimized, or mid-move) is still a game by its class or
            // folder; only the fullscreen test needs the monitor.
            let monitor = holding(&self.monitors, &f.rect).map(|m| m.rect);
            let path = w.v.process.as_ref().map(|p| p.path.as_str());
            game::judge(
                quns,
                Some(&game::Front {
                    class: &f.class,
                    style: f.style,
                    rect: f.rect,
                    monitor,
                    path,
                }),
            )
        });
        let tripped = tripped.or_else(|| game::judge(quns, None));
        if tripped.is_some() != self.game.is_some() {
            self.log_gate("game_guard", tripped.is_some());
        }
        if tripped != self.game {
            self.changed = true;
        }
        self.game = tripped;
        let acts = self.gates.set_game_guard(tripped.is_some(), now);
        self.act(acts, now);
    }

    pub fn shell(&mut self, signal: Signal, now: Instant) {
        self.stats.shell_signals += 1;
        let acts = match signal {
            Signal::DisplayChange
            | Signal::WorkArea
            | Signal::Resume
            | Signal::TaskbarCreated
            | Signal::DisplayState(1) => {
                self.settle(now);
                Vec::new()
            }
            Signal::DevicesChanged => {
                // Only a real change in the monitor list settles; most device changes are USB.
                let now_ids: Vec<String> =
                    self.probe.monitors().into_iter().map(|m| m.id).collect();
                let had: Vec<String> = self.monitors.iter().map(|m| m.id.clone()).collect();
                if now_ids != had {
                    self.settle(now);
                }
                Vec::new()
            }
            Signal::Session(7) => self.locked(true, now),
            Signal::Session(8) => self.locked(false, now),
            Signal::Session(1) => {
                self.with_gate_log("remote_session", |g| g.console_connected(now))
            }
            Signal::Session(3) => self.with_gate_log("remote_session", |g| g.remote_connected()),
            Signal::Fault => panic!("nook-shell's window procedure panicked"),
            _ => Vec::new(),
        };
        self.act(acts, now);
    }

    fn locked(&mut self, on: bool, now: Instant) -> Vec<Act> {
        self.log_gate("session_locked", on);
        self.gates.lock(on, now)
    }

    fn with_gate_log(
        &mut self,
        name: &'static str,
        f: impl FnOnce(&mut Gates) -> Vec<Act>,
    ) -> Vec<Act> {
        let before = self.gates.remote_session;
        let acts = f(&mut self.gates);
        if before != self.gates.remote_session {
            self.log_gate(name, self.gates.remote_session);
        }
        acts
    }

    fn settle(&mut self, now: Instant) {
        if !self.gates.settling(now) {
            self.log_gate("settling", true);
        }
        self.gates.settle(now);
        self.stats.settles += 1;
        self.changed = true;
    }

    /// Settles that ended and missing monitors whose wait ran out.
    pub fn tick(&mut self, now: Instant) {
        // Marks nook-com stuck once its oldest question is 500 ms old.
        self.vd_asked.may_ask(now);
        if self.gates.settling_until.is_some_and(|t| now >= t) {
            self.monitors = self.probe.monitors();
            let present: Vec<String> = self.monitors.iter().map(|m| m.id.clone()).collect();
            let watched = self.watched.clone();
            let was_missing = self.gates.display_missing_since.is_some();
            let acts = self.gates.settle_ended(now, &watched, &present);
            self.log_gate("settling", false);
            self.log_missing(was_missing);
            self.act(acts, now);
            if self.panel_open {
                self.enumerate();
            }
            self.changed = true;
        }
        if let Some(since) = self.gates.display_missing_since {
            if now >= since + MISSING_FOR {
                self.monitors = self.probe.monitors();
                let present: Vec<String> = self.monitors.iter().map(|m| m.id.clone()).collect();
                let watched = self.watched.clone();
                let acts = self.gates.check_monitors(now, &watched, &present);
                self.log_missing(true);
                self.act(acts, now);
                self.changed = true;
            }
        }
    }

    fn log_missing(&mut self, was: bool) {
        let is = self.gates.display_missing_since.is_some();
        if was != is {
            self.log_gate("display_missing", is);
        }
    }

    pub(super) fn act(&mut self, acts: Vec<Act>, _now: Instant) {
        for a in acts {
            match a {
                Act::Pass => self.stats.passes_observed += 1,
                Act::CheckAt(_) => {}
                Act::PutBack(ids) => {
                    self.stats.put_backs += 1;
                    for id in &ids {
                        diag::write(&self.dir, &Event::MonitorAway { name: id });
                    }
                    self.watched.retain(|w| !ids.contains(w));
                }
                Act::UnhideAll => self.stats.unhide_alls += 1,
                Act::ToastResume => {}
            }
        }
    }

    pub(super) fn log_gate(&mut self, name: &'static str, on: bool) {
        if on {
            *self.stats.gate_trips.entry(name).or_default() += 1;
        }
        self.changed = true;
        diag::write(&self.dir, &Event::Gate { name, on });
    }

    pub fn vd_answers(&mut self, answers: Vec<Answer>) {
        self.vd_asked.answered(answers.len());
        self.stats.vd_answers += answers.len() as u64;
        for (h, on) in answers {
            if !self.windows.contains_key(&h) {
                continue;
            }
            self.vd.insert(h, on);
            if on == Some(false) {
                self.judge(h);
            }
        }
    }

    /// Questions for nook-com, unless it is stuck.
    pub fn take_vd_questions(&mut self, now: Instant) -> Vec<Hwnd> {
        if self.vd_queue.is_empty() || !self.vd_asked.may_ask(now) {
            return Vec::new();
        }
        let asked = std::mem::take(&mut self.vd_queue);
        self.vd_asked.sent(asked.len(), now);
        asked
    }

    pub fn vd_stuck(&self) -> bool {
        self.vd_asked.stuck
    }

    /// The windows the callback should stop dropping HIDE and DESTROY for, and start again.
    pub fn take_known(&mut self) -> (Vec<Hwnd>, Vec<Hwnd>) {
        (
            std::mem::take(&mut self.known_added),
            std::mem::take(&mut self.known_removed),
        )
    }

    /// The process F1 should follow: the foreground app's, when the bar asked for it and the app
    /// isn't a game. Nothing is managed while observing, so nothing else asks. A window that went
    /// fullscreen in place is still followed: its own moves are how leaving it is heard. A bare
    /// popup is followed too, as one can go fullscreen in place; the shell and games never are.
    pub fn follow_pid(&self) -> Option<u32> {
        if !self.follow_foreground {
            return None;
        }
        let win = self.windows.get(&self.focused?)?;
        let followed = match self.game {
            Some(game::Tripped::Fullscreen) => true,
            Some(_) => false,
            None => {
                win.v.kind != Kind::Ignore
                    || win.v.stage > Stage::B
                    || matches!(win.v.why, Why::BarePopup)
            }
        };
        followed.then_some(win.v.facts.pid)
    }

    pub fn due(&self) -> Option<Instant> {
        [self.gates.due(), self.vd_asked_deadline()]
            .into_iter()
            .flatten()
            .min()
    }

    fn vd_asked_deadline(&self) -> Option<Instant> {
        self.vd_asked.deadline()
    }
}

#[cfg(test)]
mod tests {
    use super::super::state::Wm;
    use crate::nook::coalesce::Batch;
    use crate::nook::fake::{app_window, process, two_monitors, FakeProbe};
    use crate::nook::probe::Own;
    use std::time::Instant;

    #[test]
    fn f1_follows_a_bare_popup_in_front_but_never_a_game() {
        let mut p = FakeProbe::default();
        *p.screens.borrow_mut() = two_monitors();
        // WS_POPUP and WS_VISIBLE, without a frame: a player's own borderless window, say.
        let mut popup = app_window("SomePlayer", 100);
        popup.facts.style = 0x9000_0000;
        p.add(1, popup)
            .proc(100, Ok(process(r"C:\Apps\player.exe")));
        p.add(2, app_window("RiotWindowClass", 200));
        let tmp = tempfile::tempdir().unwrap();
        let own = Own {
            pid: 1,
            elevated: false,
        };
        let t = Instant::now();
        let mut w = Wm::new(p, own, tmp.path().to_path_buf(), t);
        w.follow_foreground = true;
        let front = |h| Batch {
            foreground: Some(h),
            ..Batch::default()
        };
        w.apply(&front(1), t);
        assert_eq!(w.windows[&1].v.why.code(), "bare_popup");
        assert_eq!(w.follow_pid(), Some(100));
        w.apply(&front(2), t);
        assert!(w.game.is_some());
        assert_eq!(w.follow_pid(), None, "no hook on a game's process");
    }
}
