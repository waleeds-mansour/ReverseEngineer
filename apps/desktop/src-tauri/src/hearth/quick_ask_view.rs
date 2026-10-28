// What the quick-ask box's page (src/nook/askView.ts) and Rust say to each other: the commands
// the page sends through ask_pip, and the view Rust answers with and sends as 'nook://ask'.
// quick_ask_flow.rs decides the view; these are only its shapes, in snake_case for the page.

use crate::nook::chrome::ChromeView;
use serde::{Deserialize, Serialize};
use specta::Type;

/// What the box's page asks.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AskCmd {
    /// The page loaded or came up: the view as it is.
    Ready,
    /// Enter: the text goes to Pip once the wait for an Undo is over.
    Send { text: String },
    /// Undo, its Esc key or Esc, while the ring fills: the text goes back in the box.
    Undo,
    /// The × on the line of context: the message goes without it.
    DropContext,
    /// Esc with nothing waiting: the box closes and the app it opened over gets the focus back.
    Close,
    /// A click on Pip's answer, or Enter on the empty box after it: Pip's conversation in Nook.
    OpenConversation,
    /// The mic: the box listens, and what is said goes into it as text.
    Listen,
    /// Space or a second click keeps what was said; Esc throws it away.
    StopListening { keep: bool },
    /// Tab: the next ask starts a new conversation instead of continuing the last one, or back.
    Fresh,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AskPhase {
    #[default]
    Typing,
    /// The ring fills with Esc to undo: nothing has gone yet.
    Waiting,
    /// On its way to Nook: too late to undo.
    Sending,
    /// Nook has it: the note is Pip's first words back, or "Sent to Pip".
    Sent,
    /// It didn't go: the text is back in the box and the note says why.
    Failed,
}

/// The box's mic.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AskMic {
    /// Click it to talk.
    #[default]
    Ready,
    /// Dictation, talk mode or the meeting recorder has the microphone.
    Busy,
    /// Listening until Space or a second click.
    Listening,
    /// Listening until Ctrl, held down on a double-tap's second press, is let go.
    Held,
    /// What was said is being written down.
    Hearing,
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
    /// Sent, "Sent to Pip", or that an Undo came too late, until Pip's first words back come;
    /// failed, why.
    pub note: Option<String>,
    /// How long is left to undo, while waiting.
    pub undo_ms: u32,
    /// The note is Pip's first words back.
    pub answered: bool,
    pub mic: AskMic,
    /// Words just heard, to type out at the end of what is in the box: given once, as draft is.
    pub heard: Option<String>,
    /// The title of the conversation the next ask continues (the one waiting goes to, while it
    /// waits); none starts a new one.
    pub continuing: Option<String>,
    /// Tab chose a new conversation over continuing one; Tab again continues it.
    pub fresh: bool,
    /// Nook's theme, glass and motion, as its other pages draw them.
    pub chrome: Option<ChromeView>,
}
