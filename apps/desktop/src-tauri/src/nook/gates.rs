// The gates (docs/nook-wm.md, "GATES"): independent conditions, each of which stops a layout pass,
// so clearing one never clears another. In Observing mode no pass ever runs, but the gates are
// kept exactly as an arranging Nook would keep them, so the panel and the bar can show them and
// the owner's 24-hour run sees how often each one trips. The decisions are pure: the loop passes
// in the time and the monitors it found, and acts on what comes back.

use std::time::{Duration, Instant};

/// A settle lasts this long after its last signal...
pub const SETTLE: Duration = Duration::from_secs(2);
/// ...and never longer than this after its first.
pub const SETTLE_MAX: Duration = Duration::from_secs(5);
/// How long a missing monitor is waited for before its windows are put back.
pub const MISSING_FOR: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Default)]
pub struct Gates {
    pub user_paused: bool,
    pub game_guard: bool,
    pub session_locked: bool,
    settle_started: Option<Instant>,
    pub settling_until: Option<Instant>,
    pub display_missing_since: Option<Instant>,
    /// The ids of the monitors being waited for.
    pub missing: Vec<String>,
    pub remote_session: bool,
    pub journal_failed: bool,
    pub breaker: bool,
    pub revoked: bool,
}

/// What the loop should do after a gate changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Act {
    /// Every gate is clear: an arranging Nook lays out now. Observing, it is counted.
    Pass,
    /// Look again at this time.
    CheckAt(Instant),
    /// These monitors stayed away: their windows go back where they were, and Nook stops
    /// arranging them.
    PutBack(Vec<String>),
    /// A remote session began: show everything Nook hid and remove its chrome, then pause.
    UnhideAll,
    /// Tell the owner arranging is paused until they resume it.
    ToastResume,
}

impl Gates {
    /// Whether a layout pass may run now.
    pub fn clear(&self, now: Instant) -> bool {
        !self.user_paused
            && !self.game_guard
            && !self.session_locked
            && !self.settling(now)
            && self.display_missing_since.is_none()
            && !self.remote_session
            && !self.journal_failed
            && !self.breaker
            && !self.revoked
    }

    pub fn settling(&self, now: Instant) -> bool {
        self.settling_until.is_some_and(|t| now < t)
    }

    /// A display change, a work-area change, a resume, an unlock and the like: wait for Windows
    /// to finish moving things before looking again.
    pub fn settle(&mut self, now: Instant) -> Instant {
        let started = *self.settle_started.get_or_insert(now);
        let until = (now + SETTLE).min(started + SETTLE_MAX);
        self.settling_until = Some(until);
        until
    }

    /// The settle ended. `watched` are the monitors Nook arranges or journaled, `present` the
    /// ones Windows lists now.
    pub fn settle_ended(
        &mut self,
        now: Instant,
        watched: &[String],
        present: &[String],
    ) -> Vec<Act> {
        self.settle_started = None;
        self.settling_until = None;
        self.check_monitors(now, watched, present)
    }

    /// Also called when a missing monitor's wait runs out.
    pub fn check_monitors(
        &mut self,
        now: Instant,
        watched: &[String],
        present: &[String],
    ) -> Vec<Act> {
        let missing: Vec<String> = watched
            .iter()
            .filter(|id| !present.contains(id))
            .cloned()
            .collect();
        if missing.is_empty() {
            self.display_missing_since = None;
            self.missing.clear();
            return self.pass_if_clear(now);
        }
        let since = *self.display_missing_since.get_or_insert(now);
        self.missing = missing;
        if now.saturating_duration_since(since) >= MISSING_FOR {
            self.display_missing_since = None;
            let gone = std::mem::take(&mut self.missing);
            let mut acts = vec![Act::PutBack(gone)];
            acts.extend(self.pass_if_clear(now));
            return acts;
        }
        vec![Act::CheckAt(since + MISSING_FOR)]
    }

    pub fn lock(&mut self, locked: bool, now: Instant) -> Vec<Act> {
        self.session_locked = locked;
        if locked {
            Vec::new()
        } else {
            vec![Act::CheckAt(self.settle(now))]
        }
    }

    /// WTS_REMOTE_CONNECT, or SM_REMOTESESSION at start.
    pub fn remote_connected(&mut self) -> Vec<Act> {
        self.remote_session = true;
        vec![Act::UnhideAll]
    }

    /// WTS_CONSOLE_CONNECT: back at the PC. Settle and stay paused until the owner resumes.
    pub fn console_connected(&mut self, now: Instant) -> Vec<Act> {
        let was_remote = std::mem::take(&mut self.remote_session);
        if was_remote {
            self.user_paused = true;
        }
        let mut acts = vec![Act::CheckAt(self.settle(now))];
        if was_remote {
            acts.push(Act::ToastResume);
        }
        acts
    }

    pub fn set_game_guard(&mut self, tripped: bool, now: Instant) -> Vec<Act> {
        let was = std::mem::replace(&mut self.game_guard, tripped);
        if was && !tripped {
            self.pass_if_clear(now)
        } else {
            Vec::new()
        }
    }

    fn pass_if_clear(&self, now: Instant) -> Vec<Act> {
        if self.clear(now) {
            vec![Act::Pass]
        } else {
            Vec::new()
        }
    }

    /// The earliest time the loop must look at the gates again.
    pub fn due(&self) -> Option<Instant> {
        let missing = self.display_missing_since.map(|t| t + MISSING_FOR);
        [self.settling_until, missing].into_iter().flatten().min()
    }

    /// The gates that are set, by name, for the panel, the bar and diag.
    pub fn names(&self, now: Instant) -> Vec<&'static str> {
        let all = [
            (self.user_paused, "user_paused"),
            (self.game_guard, "game_guard"),
            (self.session_locked, "session_locked"),
            (self.settling(now), "settling"),
            (self.display_missing_since.is_some(), "display_missing"),
            (self.remote_session, "remote_session"),
            (self.journal_failed, "journal_failed"),
            (self.breaker, "breaker"),
            (self.revoked, "revoked"),
        ];
        all.into_iter()
            .filter(|(on, _)| *on)
            .map(|(_, n)| n)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_settle_is_extended_by_new_signals_up_to_five_seconds() {
        let t0 = Instant::now();
        let mut g = Gates::default();
        assert_eq!(g.settle(t0), t0 + SETTLE);
        assert_eq!(
            g.settle(t0 + Duration::from_secs(1)),
            t0 + Duration::from_secs(3)
        );
        assert_eq!(g.settle(t0 + Duration::from_secs(4)), t0 + SETTLE_MAX);
        assert!(g.settling(t0 + Duration::from_millis(4900)));
        assert!(!g.settling(t0 + SETTLE_MAX));
    }

    #[test]
    fn a_settle_ending_under_the_game_guard_runs_no_pass() {
        let t0 = Instant::now();
        let mut g = Gates::default();
        g.settle(t0);
        g.game_guard = true;
        let present = ids(&["a"]);
        assert!(g.settle_ended(t0 + SETTLE, &present, &present).is_empty());
        assert_eq!(g.set_game_guard(false, t0 + SETTLE), vec![Act::Pass]);
    }

    #[test]
    fn a_settle_ending_with_everything_clear_runs_one_pass() {
        let t0 = Instant::now();
        let mut g = Gates::default();
        g.settle(t0);
        let present = ids(&["a", "b"]);
        assert_eq!(
            g.settle_ended(t0 + SETTLE, &ids(&["a"]), &present),
            vec![Act::Pass]
        );
        assert!(g.names(t0 + SETTLE).is_empty());
    }

    #[test]
    fn a_missing_monitor_is_waited_for_thirty_seconds_then_put_back() {
        let t0 = Instant::now();
        let mut g = Gates::default();
        let watched = ids(&["d1"]);
        let acts = g.settle_ended(t0, &watched, &[]);
        assert_eq!(acts, vec![Act::CheckAt(t0 + MISSING_FOR)]);
        assert!(!g.clear(t0));
        assert_eq!(g.names(t0), vec!["display_missing"]);
        let later = t0 + Duration::from_secs(10);
        assert_eq!(
            g.settle_ended(later, &watched, &[]),
            vec![Act::CheckAt(t0 + MISSING_FOR)]
        );
        let acts = g.check_monitors(t0 + MISSING_FOR, &watched, &[]);
        assert_eq!(acts, vec![Act::PutBack(ids(&["d1"])), Act::Pass]);
        assert!(g.display_missing_since.is_none());
    }

    #[test]
    fn a_monitor_that_comes_back_in_time_clears_the_gate() {
        let t0 = Instant::now();
        let mut g = Gates::default();
        let watched = ids(&["d1"]);
        g.settle_ended(t0, &watched, &[]);
        let acts = g.settle_ended(t0 + Duration::from_secs(12), &watched, &watched);
        assert_eq!(acts, vec![Act::Pass]);
        assert!(g.clear(t0 + Duration::from_secs(12)));
    }

    #[test]
    fn a_remote_session_unhides_and_the_console_comes_back_paused() {
        let t0 = Instant::now();
        let mut g = Gates::default();
        assert_eq!(g.remote_connected(), vec![Act::UnhideAll]);
        assert!(!g.clear(t0));
        let acts = g.console_connected(t0);
        assert_eq!(acts, vec![Act::CheckAt(t0 + SETTLE), Act::ToastResume]);
        assert!(!g.remote_session);
        assert!(g.user_paused, "stays paused until the owner resumes");
        let present = ids(&["a"]);
        assert!(g.settle_ended(t0 + SETTLE, &present, &present).is_empty());
    }

    #[test]
    fn gates_are_independent() {
        let t0 = Instant::now();
        let mut g = Gates::default();
        g.lock(true, t0);
        g.game_guard = true;
        assert!(g.set_game_guard(false, t0).is_empty(), "still locked");
        let acts = g.lock(false, t0);
        assert_eq!(acts, vec![Act::CheckAt(t0 + SETTLE)]);
        assert_eq!(g.due(), Some(t0 + SETTLE));
    }
}
