// The quick-ask box's mic, as quick_ask_flow.rs decides it: listening, held by Ctrl or not, then
// writing down what it heard, which the box types out at the end of what is in it to read over
// and send. quick_ask_talk.rs records and transcribes; this only keeps track, of the recording
// too: until the audio manager lets go of it, the microphone is the box's own, and once it does
// the view changes, so the page draws whether another recording has it now.

use super::{Flow, Phase, Talk, HEARD_NOTHING};
use crate::hearth::quick_ask_parts::typed;

impl Flow {
    /// The mic: the box listens, held by Ctrl or not. Its id; None while it already listens or
    /// writes, or a message waits or goes. After an answer the box is ready for the next ask.
    pub fn listen(&mut self, held: bool) -> Option<u64> {
        let busy = matches!(self.phase, Phase::Waiting { .. } | Phase::Sending { .. });
        if busy || self.talk != Talk::Idle {
            return None;
        }
        if let Phase::Sent { .. } = self.phase {
            self.phase = Phase::Typing;
        }
        self.talks += 1;
        self.talk = Talk::Listening {
            id: self.talks,
            held,
        };
        self.recorder = Some(self.talks);
        self.talk_note = None;
        self.changed();
        Some(self.talks)
    }

    /// What listens now: its id, and whether Ctrl holds it.
    pub fn listening(&self) -> Option<(u64, bool)> {
        match self.talk {
            Talk::Listening { id, held } => Some((id, held)),
            _ => None,
        }
    }

    /// Listening `id` stopped: kept, what it heard is written down next; otherwise it's gone.
    pub fn stopped(&mut self, id: u64, keep: bool) -> bool {
        if !matches!(self.talk, Talk::Listening { id: l, .. } if l == id) {
            return false;
        }
        self.talk = if keep {
            Talk::Hearing { id }
        } else {
            Talk::Idle
        };
        self.changed();
        true
    }

    /// The audio manager let go of listening `id`'s recording, or never started it.
    pub fn released(&mut self, id: u64) -> bool {
        if self.recorder != Some(id) {
            return false;
        }
        self.recorder = None;
        self.changed();
        true
    }

    /// Whether the mic shows busy when some recording has the microphone (`taken`): not while
    /// the box listens or writes, nor while that recording is still its own.
    pub fn mic_busy(&self, taken: bool) -> bool {
        taken && self.talk == Talk::Idle && self.recorder.is_none()
    }

    /// Esc, or the box put away, while what was said is written down: it is thrown away, and
    /// never lands in the box.
    pub fn forget_hearing(&mut self) -> bool {
        if !matches!(self.talk, Talk::Hearing { .. }) {
            return false;
        }
        self.talk = Talk::Idle;
        self.changed();
        true
    }

    /// What listening `id` heard, to type into the box; nothing heard says so.
    pub fn heard(&mut self, id: u64, words: &str) -> bool {
        if self.talk != (Talk::Hearing { id }) {
            return false;
        }
        self.talk = Talk::Idle;
        self.changed();
        let words = typed(words);
        if words.is_empty() {
            self.talk_note = Some(HEARD_NOTHING.into());
        } else {
            self.heard = Some((self.seq, words));
        }
        true
    }

    /// Listening `id` couldn't start, or what it heard couldn't be written down: why.
    pub fn talk_failed(&mut self, id: u64, why: &str) -> bool {
        let ours = match self.talk {
            Talk::Listening { id: t, .. } | Talk::Hearing { id: t } => t == id,
            Talk::Idle => false,
        };
        if !ours {
            return false;
        }
        // One that couldn't start holds nothing.
        if matches!(self.talk, Talk::Listening { .. }) && self.recorder == Some(id) {
            self.recorder = None;
        }
        self.talk = Talk::Idle;
        self.talk_note = Some(why.into());
        self.changed();
        true
    }
}
