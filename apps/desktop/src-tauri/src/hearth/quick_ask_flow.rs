// The quick-ask box (Ask Pip), decided without touching a window so it can be tested anywhere;
// quick_ask.rs carries it out. Its shortcut, or a double-tap of Ctrl, opens it over the app in
// front, which it remembers: that app's name and its window's title go with what you type as
// chat.send's context (never a screenshot), which Nook hands Pip apart from your words, as
// outside data, since someone else may have written a title. The box shows that line whole, with
// an × to send without it, and Esc gives that app the focus back. Its mic listens, and what was
// said is typed into the box to read over (quick_ask_talk.rs). Enter starts a wait of UNDO_FOR
// while a ring fills, with Esc to undo, which puts the text back in the box; only then does the
// message go to Pip, through chat.send as talk mode's words do. An ask within FOLLOW_UP of the
// last one continues its conversation, saying so, and Tab starts a new one instead, a choice that
// holds while the box is put away and opened again; when Nook says that conversation is gone, the
// ask starts a new one, and the box says that too. What happens
// next is Pip's to decide under its own approval rules: the device token sends a message and
// nothing more.

use super::quick_ask_parts::{first_words, title_of, typed, Context, Outgoing, Over, Thread};
pub use super::quick_ask_view::{AskCmd, AskMic, AskPhase, AskView};
use std::time::{Duration, Instant};

/// How long the ring fills before the message goes.
pub const UNDO_FOR: Duration = Duration::from_secs(2);
pub const SENT: &str = "Sent to Pip";
/// Sent, when the conversation it followed was gone and it started a new one.
pub const SENT_NEW: &str = "Sent to Pip, in a new conversation";
pub const TOO_LATE: &str = "Too late, it went to Pip.";
pub const HEARD_NOTHING: &str = "Didn't catch that. Try again, or type it.";

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Typing,
    Waiting {
        id: u64,
        out: Outgoing,
        until: Instant,
        to: Option<Thread>,
    },
    Sending {
        id: u64,
        out: Outgoing,
        to: Option<Thread>,
    },
    /// Nook has it; Pip's first words back, once they come. `anew`: the conversation it was to
    /// follow was gone, and it went into a new one.
    Sent {
        id: u64,
        words: Option<String>,
        anew: bool,
    },
    Failed {
        why: String,
    },
}

/// The mic: listening `id`, held by Ctrl or not, then writing down what it heard.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Talk {
    Idle,
    Listening { id: u64, held: bool },
    Hearing { id: u64 },
}

/// The box between uses: the app it remembers, and where the last thing typed in it is.
#[derive(Debug)]
pub struct Flow {
    over: Option<Over>,
    /// What the next message goes with, until the box opens over another app or its × is clicked.
    context: Option<Context>,
    phase: Phase,
    ids: u64,
    seq: u64,
    /// Text an Undo or a failure put back in the box, with the change that did: the page is told
    /// it with that change only, so a box opened again keeps what was typed in it since.
    put_back: Option<(u64, String)>,
    /// The message an Undo came too late for.
    late: Option<u64>,
    talk: Talk,
    talks: u64,
    /// The listening whose recording the audio manager may still hold, until it lets go
    /// (quick_ask_talk.rs): the microphone is the box's own then, not another recording's.
    recorder: Option<u64>,
    /// Words heard, with the change that brought them, told to the page once as put_back is.
    heard: Option<(u64, String)>,
    /// Why the mic heard nothing, until the next send, listening or opening.
    talk_note: Option<String>,
    /// The conversation the last quick ask went to.
    thread: Option<Thread>,
    /// Tab: the next ask starts a new conversation.
    fresh: bool,
}

impl Default for Flow {
    fn default() -> Self {
        Flow::new()
    }
}

impl Flow {
    pub const fn new() -> Flow {
        Flow {
            over: None,
            context: None,
            phase: Phase::Typing,
            ids: 0,
            seq: 0,
            put_back: None,
            late: None,
            talk: Talk::Idle,
            talks: 0,
            recorder: None,
            heard: None,
            talk_note: None,
            thread: None,
            fresh: false,
        }
    }

    fn changed(&mut self) {
        self.seq += 1;
    }

    /// The change that puts `text` back in the box.
    fn changed_back(&mut self, text: String) {
        self.changed();
        self.put_back = Some((self.seq, text));
    }

    pub fn over(&self) -> Option<&Over> {
        self.over.as_ref()
    }

    /// Its shortcut opened the box over `over`; None when that was the box itself, which keeps
    /// the app it remembers. After an answer it opens empty; waiting, sending or failed, as it
    /// was, a message on its way still showing the context it goes with. Tab's choice holds while
    /// the conversation it passes over could still be continued.
    pub fn opened(&mut self, over: Option<Over>) {
        if let Some(over) = over {
            self.context = Context::of(&over);
            self.over = Some(over);
        }
        if let Phase::Sent { .. } = self.phase {
            self.phase = Phase::Typing;
        }
        self.talk_note = None;
        self.changed();
    }

    /// The conversation an ask at `now` continues, unless Tab chose a new one.
    fn continues(&self, now: Instant) -> Option<&Thread> {
        self.thread.as_ref().filter(|t| t.continues_at(now))
    }

    /// Tab: a new conversation instead of the one the next ask would continue, or back to it.
    /// Nothing while there is none, or a message waits or goes.
    pub fn toggle_fresh(&mut self, now: Instant) {
        let busy = matches!(self.phase, Phase::Waiting { .. } | Phase::Sending { .. });
        if busy || self.continues(now).is_none() {
            return;
        }
        self.fresh = !self.fresh;
        self.changed();
    }

    /// Enter: the wait for an Undo starts, with the context and conversation as they are now.
    /// The wait's id; None while a message already waits or goes, as a second Enter does nothing.
    pub fn send(&mut self, text: &str, now: Instant) -> Result<Option<u64>, &'static str> {
        if matches!(self.phase, Phase::Waiting { .. } | Phase::Sending { .. }) {
            return Ok(None);
        }
        let text = typed(text);
        if text.is_empty() {
            return Err("Type something for Pip first.");
        }
        let to = self.continues(now).filter(|_| !self.fresh).cloned();
        self.ids += 1;
        let (id, until) = (self.ids, now + UNDO_FOR);
        let out = Outgoing {
            text,
            context: self.context.clone(),
            conversation: to.as_ref().map(|t| t.id.clone()),
        };
        self.phase = Phase::Waiting { id, out, until, to };
        self.talk_note = None;
        self.changed();
        Ok(Some(id))
    }

    /// Undo: whether it came in time. The text goes back in the box with the context it was to
    /// go with; too late, the box says so.
    pub fn undo(&mut self) -> bool {
        match &self.phase {
            Phase::Waiting { out, .. } => {
                let (text, context) = (out.text.clone(), out.context.clone());
                self.phase = Phase::Typing;
                self.context = context;
                self.changed_back(text);
                true
            }
            Phase::Sending { id, .. } | Phase::Sent { id, .. } => {
                self.late = Some(*id);
                self.changed();
                false
            }
            Phase::Typing | Phase::Failed { .. } => false,
        }
    }

    /// The × on the line of context: the message on show goes without it, and so does what is
    /// typed next, until the box opens over an app again. Too late once it goes.
    pub fn drop_context(&mut self) {
        match &mut self.phase {
            Phase::Sending { .. } => return,
            Phase::Waiting { out, .. } => {
                if self.context == out.context {
                    self.context = None;
                }
                out.context = None;
            }
            _ => self.context = None,
        }
        self.changed();
    }

    /// The wait `id` is over: what to send now, unless it was undone.
    pub fn due(&mut self, id: u64) -> Option<Outgoing> {
        let Phase::Waiting {
            id: waiting,
            out,
            to,
            ..
        } = &self.phase
        else {
            return None;
        };
        if *waiting != id {
            return None;
        }
        let (out, to) = (out.clone(), to.clone());
        self.phase = Phase::Sending {
            id,
            out: out.clone(),
            to,
        };
        self.changed();
        Some(out)
    }

    /// Nook took message `id` into `conversation`, at `now`: the next ask continues it. Its title
    /// stays when it is the one asked for; otherwise it is new, titled by this message.
    pub fn sent(&mut self, id: u64, conversation: &str, now: Instant) -> bool {
        let Phase::Sending { id: s, out, to } = &self.phase else {
            return false;
        };
        if *s != id {
            return false;
        }
        let title = match to {
            Some(t) if t.id == conversation => t.title.clone(),
            _ => title_of(&out.text),
        };
        let anew = to.as_ref().is_some_and(|t| t.id != conversation);
        self.thread = Some(Thread {
            id: conversation.to_string(),
            title,
            at: now,
        });
        self.fresh = false;
        self.phase = Phase::Sent {
            id,
            words: None,
            anew,
        };
        self.changed();
        true
    }

    /// Whether message `id`'s answer is what the box shows now.
    pub fn showing(&self, id: u64) -> bool {
        matches!(self.phase, Phase::Sent { id: s, .. } if s == id)
    }

    /// Pip's first words back to message `id`, while the box still shows it.
    pub fn answered(&mut self, id: u64, words: &str) -> bool {
        let words = first_words(words);
        let Phase::Sent { anew, .. } = self.phase else {
            return false;
        };
        if !self.showing(id) || words.is_empty() {
            return false;
        }
        self.phase = Phase::Sent {
            id,
            words: Some(words),
            anew,
        };
        self.changed();
        true
    }

    /// Message `id` didn't go: what was typed goes back in the box with its context, saying why.
    pub fn failed(&mut self, id: u64, why: &str) -> bool {
        let Phase::Sending { id: s, out, .. } = &self.phase else {
            return false;
        };
        if *s != id {
            return false;
        }
        let (text, context) = (out.text.clone(), out.context.clone());
        self.context = context;
        self.phase = Phase::Failed { why: why.into() };
        self.changed_back(text);
        true
    }

    pub fn view(&self, now: Instant) -> AskView {
        let late = |id: u64| (self.late == Some(id)).then(|| TOO_LATE.to_string());
        let next = self.continues(now);
        let (phase, note, undo_ms, context, to) = match &self.phase {
            Phase::Typing => (AskPhase::Typing, None, 0, &self.context, next),
            Phase::Waiting { until, out, to, .. } => {
                let left = until.saturating_duration_since(now).as_millis();
                let left = left.min(u128::from(u32::MAX)) as u32;
                (AskPhase::Waiting, None, left, &out.context, to.as_ref())
            }
            Phase::Sending { id, out, to } => {
                (AskPhase::Sending, late(*id), 0, &out.context, to.as_ref())
            }
            // Pip's first words say more than that it was too late.
            Phase::Sent { id, words, anew } => {
                let note = words.clone().or_else(|| late(*id));
                let note = note.unwrap_or_else(|| if *anew { SENT_NEW } else { SENT }.into());
                (AskPhase::Sent, Some(note), 0, &self.context, next)
            }
            Phase::Failed { why } => (AskPhase::Failed, Some(why.clone()), 0, &self.context, next),
        };
        let waits = matches!(phase, AskPhase::Waiting | AskPhase::Sending);
        let to = to.filter(|_| waits || !self.fresh);
        let once = |kept: &Option<(u64, String)>| {
            kept.as_ref()
                .filter(|(at, _)| *at == self.seq)
                .map(|(_, text)| text.clone())
        };
        AskView {
            seq: self.seq,
            phase,
            from: context.as_ref().map(Context::line),
            draft: once(&self.put_back),
            // The mic's why, over a failure's: it is the newer.
            note: match phase {
                AskPhase::Typing | AskPhase::Failed => self.talk_note.clone().or(note),
                _ => note,
            },
            undo_ms,
            answered: matches!(&self.phase, Phase::Sent { words: Some(_), .. }),
            mic: match self.talk {
                Talk::Idle => AskMic::Ready,
                Talk::Listening { held: false, .. } => AskMic::Listening,
                Talk::Listening { held: true, .. } => AskMic::Held,
                Talk::Hearing { .. } => AskMic::Hearing,
            },
            heard: once(&self.heard),
            continuing: to.map(|t| t.title.clone()),
            fresh: !waits && self.fresh && next.is_some(),
            chrome: None,
        }
    }
}

// The mic's part of the flow: listening, and what it heard.
#[path = "quick_ask_mic.rs"]
mod mic;

#[cfg(test)]
#[path = "quick_ask_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "quick_ask_more_tests.rs"]
mod more_tests;
