// The quick-ask box (Ask Pip), decided without touching a window so it can be tested anywhere;
// quick_ask.rs carries it out. Its shortcut opens it over the app in front, which it remembers:
// that app's name and its window's title go with what you type as chat.send's context (never a
// screenshot), which Nook hands Pip apart from your words, as outside data, since someone else may
// have written a title. The box shows that line whole, with an × to send without it, and Esc
// gives that app the focus back. Enter starts a wait of UNDO_FOR that says "Sending…" with an
// Undo, which puts the text back in the box; only then does the message go to Pip, through
// chat.send as talk mode's words do, and the box shows Pip's first words back, or "Sent to Pip".
// What happens next is Pip's to decide under its own approval rules: the device token sends a
// message and nothing more.

use super::quick_ask_parts::{first_words, typed, Context, Outgoing, Over};
use crate::nook::chrome::ChromeView;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::{Duration, Instant};

/// How long "Sending…" waits for an Undo before the message goes.
pub const UNDO_FOR: Duration = Duration::from_secs(2);
pub const SENT: &str = "Sent to Pip";
pub const TOO_LATE: &str = "Too late, it went to Pip.";

/// What the box's page asks.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AskCmd {
    /// The page loaded or came up: the view as it is.
    Ready,
    /// Enter: the text goes to Pip once the wait for an Undo is over.
    Send { text: String },
    /// Undo, its button or Esc, while it says Sending…: the text goes back in the box.
    Undo,
    /// The × on the line of context: the message goes without it.
    DropContext,
    /// Esc with nothing waiting: the box closes and the app it opened over gets the focus back.
    Close,
    /// A click on Pip's answer, or Enter on the empty box after it: Pip's conversation in Nook.
    OpenConversation,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AskPhase {
    #[default]
    Typing,
    /// Sending… with Undo: nothing has gone yet.
    Waiting,
    /// On its way to Nook: too late to undo.
    Sending,
    /// Nook has it: the note is Pip's first words back, or "Sent to Pip".
    Sent,
    /// It didn't go: the text is back in the box and the note says why.
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct AskView {
    /// Goes up with every change, so the page takes each one once.
    pub seq: u64,
    pub phase: AskPhase,
    /// The context the message goes with, whole: From Google Chrome: "Pull request…".
    pub from: Option<String>,
    /// Text to put back in the box, after an Undo or a failure; none leaves the box as it is.
    pub draft: Option<String>,
    pub note: Option<String>,
    /// How long is left to undo, while waiting.
    pub undo_ms: u32,
    /// Nook's theme, glass and motion, as its other pages draw them.
    pub chrome: Option<ChromeView>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Typing,
    Waiting {
        id: u64,
        text: String,
        context: Option<Context>,
        until: Instant,
    },
    Sending {
        id: u64,
        text: String,
        context: Option<Context>,
    },
    Sent {
        id: u64,
        note: String,
    },
    Failed {
        why: String,
    },
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
    /// was, a message on its way still showing the context it goes with.
    pub fn opened(&mut self, over: Option<Over>) {
        if let Some(over) = over {
            self.context = Context::of(&over);
            self.over = Some(over);
        }
        if let Phase::Sent { .. } = self.phase {
            self.phase = Phase::Typing;
        }
        self.changed();
    }

    /// Enter: the wait for an Undo starts, with the context as it is now. The wait's id; None
    /// while a message already waits or goes, as a second Enter does nothing.
    pub fn send(&mut self, text: &str, now: Instant) -> Result<Option<u64>, &'static str> {
        if matches!(self.phase, Phase::Waiting { .. } | Phase::Sending { .. }) {
            return Ok(None);
        }
        let text = typed(text);
        if text.is_empty() {
            return Err("Type something for Pip first.");
        }
        self.ids += 1;
        let (id, until) = (self.ids, now + UNDO_FOR);
        self.phase = Phase::Waiting {
            id,
            text,
            context: self.context.clone(),
            until,
        };
        self.changed();
        Ok(Some(id))
    }

    /// Undo: whether it came in time. The text goes back in the box with the context it was to
    /// go with; too late, the box says so.
    pub fn undo(&mut self) -> bool {
        match &self.phase {
            Phase::Waiting { text, context, .. } => {
                let (text, context) = (text.clone(), context.clone());
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
            Phase::Waiting { context, .. } => {
                if self.context == *context {
                    self.context = None;
                }
                *context = None;
            }
            _ => self.context = None,
        }
        self.changed();
    }

    /// The wait `id` is over: what to send now, unless it was undone.
    pub fn due(&mut self, id: u64) -> Option<Outgoing> {
        let Phase::Waiting {
            id: waiting,
            text,
            context,
            ..
        } = &self.phase
        else {
            return None;
        };
        if *waiting != id {
            return None;
        }
        let out = Outgoing {
            text: text.clone(),
            context: context.clone(),
        };
        self.phase = Phase::Sending {
            id,
            text: out.text.clone(),
            context: out.context.clone(),
        };
        self.changed();
        Some(out)
    }

    /// Nook took message `id`.
    pub fn sent(&mut self, id: u64) -> bool {
        if !matches!(self.phase, Phase::Sending { id: s, .. } if s == id) {
            return false;
        }
        self.phase = Phase::Sent {
            id,
            note: SENT.into(),
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
        if !self.showing(id) || words.is_empty() {
            return false;
        }
        self.phase = Phase::Sent { id, note: words };
        self.changed();
        true
    }

    /// Message `id` didn't go: what was typed goes back in the box with its context, saying why.
    pub fn failed(&mut self, id: u64, why: &str) -> bool {
        let Phase::Sending {
            id: s,
            text,
            context,
        } = &self.phase
        else {
            return false;
        };
        if *s != id {
            return false;
        }
        let (text, context) = (text.clone(), context.clone());
        self.context = context;
        self.phase = Phase::Failed { why: why.into() };
        self.changed_back(text);
        true
    }

    pub fn view(&self, now: Instant) -> AskView {
        let late = |id: u64| (self.late == Some(id)).then(|| TOO_LATE.to_string());
        let (phase, note, undo_ms, context) = match &self.phase {
            Phase::Typing => (AskPhase::Typing, None, 0, &self.context),
            Phase::Waiting { until, context, .. } => {
                let left = until.saturating_duration_since(now).as_millis();
                let left = left.min(u128::from(u32::MAX)) as u32;
                (AskPhase::Waiting, None, left, context)
            }
            Phase::Sending { id, context, .. } => (AskPhase::Sending, late(*id), 0, context),
            // Pip's first words say more than that it was too late.
            Phase::Sent { id, note } => {
                let note = late(*id)
                    .filter(|_| note == SENT)
                    .unwrap_or_else(|| note.clone());
                (AskPhase::Sent, Some(note), 0, &self.context)
            }
            Phase::Failed { why } => (AskPhase::Failed, Some(why.clone()), 0, &self.context),
        };
        let draft = self.put_back.as_ref().filter(|(at, _)| *at == self.seq);
        AskView {
            seq: self.seq,
            phase,
            from: context.as_ref().map(Context::line),
            draft: draft.map(|(_, text)| text.clone()),
            note,
            undo_ms,
            chrome: None,
        }
    }
}

#[cfg(test)]
#[path = "quick_ask_tests.rs"]
mod tests;
