// Pip in Nook's bar (docs/nook-wm.md, "PIP IN THE BAR" and "DATA FOR THE BAR"). Hearth's server
// has no field a device may read that says Pip is working, so the bar's Pip follows what this PC
// itself asks of Pip: listening while the command or talk key is held, thinking until the answer
// comes back, and happy for a moment when it does. Approvals and the other notifications Hearth
// sends this PC come from its notify feed and wait on the Pip chip until the owner looks at
// Hearth's window. Every mood ages out to idle, so an answer lost to a restarting server never
// leaves the island open. Nothing here runs while the bar is off.

use super::chrome::{PipMood, PipView};
use std::time::Duration;

/// How long a mood may last with nothing new before it ages out to idle.
pub fn ages_after(mood: PipMood) -> Option<Duration> {
    match mood {
        PipMood::Idle => None,
        // The longest a key is held; talk mode's recordings are the long ones.
        PipMood::Listening => Some(Duration::from_secs(120)),
        // Talk mode waits up to 180 s for Pip's answer (hearth::talk).
        PipMood::Thinking => Some(Duration::from_secs(180)),
        // One hop.
        PipMood::Happy => Some(Duration::from_millis(1200)),
    }
}

/// The most notifications the chip counts.
pub const MOST_WAITING: u32 = 99;

#[derive(Debug, Default)]
pub struct Pip {
    pub mood: PipMood,
    /// Goes up with every new mood.
    pub changed: u64,
    /// Goes up with every mood set, even the same one again, so only the latest age-out counts.
    epoch: u64,
    pub waiting: u32,
}

/// An age-out to schedule: after `after`, call `Pip::age(epoch)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgeOut {
    pub epoch: u64,
    pub after: Duration,
}

impl Pip {
    /// Pip's mood is now `mood`. Returns whether the bar should hear of it, and the age-out to
    /// schedule.
    pub fn set(&mut self, mood: PipMood) -> (bool, Option<AgeOut>) {
        self.epoch += 1;
        let changed = mood != self.mood;
        if changed {
            self.mood = mood;
            self.changed += 1;
        }
        let age = ages_after(mood).map(|after| AgeOut {
            epoch: self.epoch,
            after,
        });
        (changed, age)
    }

    /// An age-out came due: idle, unless Pip's mood was set again since.
    pub fn age(&mut self, epoch: u64) -> bool {
        if epoch != self.epoch || self.mood == PipMood::Idle {
            return false;
        }
        self.set(PipMood::Idle).0
    }

    /// The recording ended without reaching Pip: too short, nothing heard, or it failed.
    pub fn ended(&mut self) -> bool {
        self.mood == PipMood::Listening && self.set(PipMood::Idle).0
    }

    /// The stop key: whatever Pip was doing for this PC, it stops.
    pub fn cancelled(&mut self) -> bool {
        self.mood.working() && self.set(PipMood::Idle).0
    }

    /// Hearth sent a notification: one more waits on the chip.
    pub fn notified(&mut self) -> bool {
        let before = self.waiting;
        self.waiting = (self.waiting + 1).min(MOST_WAITING);
        self.waiting != before
    }

    /// The owner looked at Hearth's window. Whether anything was waiting.
    pub fn seen(&mut self) -> bool {
        std::mem::take(&mut self.waiting) > 0
    }

    pub fn view(&self, stop_key: Vec<String>) -> PipView {
        PipView {
            mood: self.mood,
            changed: self.changed,
            waiting: self.waiting,
            stop_key,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_listens_thinks_answers_and_rests() {
        let mut pip = Pip::default();
        let (changed, age) = pip.set(PipMood::Listening);
        assert!(changed);
        assert_eq!(age.unwrap().after, Duration::from_secs(120));
        assert!(pip.set(PipMood::Thinking).0);
        let (_, happy) = pip.set(PipMood::Happy);
        let happy = happy.unwrap();
        assert!(happy.after < Duration::from_secs(2));
        assert!(pip.age(happy.epoch));
        assert_eq!(pip.mood, PipMood::Idle);
        assert_eq!(pip.changed, 4);
    }

    #[test]
    fn only_the_latest_age_out_counts() {
        let mut pip = Pip::default();
        let (_, first) = pip.set(PipMood::Thinking);
        // The same mood again: nothing new to draw, but the clock starts again.
        let (changed, second) = pip.set(PipMood::Thinking);
        assert!(!changed);
        assert!(!pip.age(first.unwrap().epoch), "an older age-out is stale");
        assert_eq!(pip.mood, PipMood::Thinking);
        assert!(pip.age(second.unwrap().epoch));
        assert_eq!(pip.mood, PipMood::Idle);
        assert!(!pip.age(second.unwrap().epoch), "idle stays idle");
        assert_eq!(pip.set(PipMood::Idle), (false, None));
    }

    #[test]
    fn a_recording_that_ends_stops_listening_and_the_stop_key_stops_both() {
        let mut pip = Pip::default();
        pip.set(PipMood::Thinking);
        assert!(!pip.ended(), "the answer is still coming");
        assert_eq!(pip.mood, PipMood::Thinking);
        pip.set(PipMood::Listening);
        assert!(pip.ended());
        assert_eq!(pip.mood, PipMood::Idle);
        pip.set(PipMood::Thinking);
        assert!(pip.cancelled());
        assert_eq!(pip.mood, PipMood::Idle);
        pip.set(PipMood::Happy);
        assert!(!pip.cancelled(), "a hop finishes on its own");
    }

    #[test]
    fn notifications_wait_until_hearth_is_looked_at() {
        let mut pip = Pip::default();
        assert!(!pip.seen());
        assert!(pip.notified());
        assert!(pip.notified());
        assert_eq!(pip.view(vec!["Esc".into()]).waiting, 2);
        assert!(pip.seen());
        assert_eq!(pip.waiting, 0);
        pip.waiting = MOST_WAITING;
        assert!(!pip.notified());
    }
}
