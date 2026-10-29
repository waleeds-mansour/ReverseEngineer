// What the quick-ask box (quick_ask_flow.rs) is given and gives: the app it opened over, where a
// message was asked as chat.send's context takes it, what goes to Pip and the conversation it
// continues, what you typed and a window's title tidied to a line, and where the box's window
// sits on a monitor.

use serde::Serialize;
use std::time::{Duration, Instant};

/// The most the box sends of what you type; chat.send takes up to 20,000 characters.
pub const MAX_TEXT: usize = 4_000;
/// The box's window in logical px: ask.css's card, with a line of context that wraps to three
/// lines at most, its 48 px pill and a line below it, and room for its shadow.
pub const BOX_SIZE: (i32, i32) = (560, 168);
/// A quick ask this soon after the last one continues its conversation, unless Tab says not to.
pub const FOLLOW_UP: Duration = Duration::from_secs(10 * 60);
const APP_MAX: usize = 60;
const TITLE_MAX: usize = 120;
const WORDS_MAX: usize = 240;
/// As long as Nook's own title for a conversation it starts from a message (chat.send).
const THREAD_TITLE_MAX: usize = 60;

/// The app the box opened over.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Over {
    /// Its window, to give the focus back to, and that window's process, so a handle Windows has
    /// given to another app's window since isn't.
    pub hwnd: isize,
    pub pid: u32,
    /// Its name, like "Google Chrome", and its window's title: none for Nook's own windows.
    pub app: Option<String>,
    pub title: Option<String>,
}

/// Where a message was asked, as chat.send's context takes it: the app's name and its window's
/// title, each a single line, and only what there is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Context {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl Context {
    /// None over Nook's own windows, which are nothing to tell Pip.
    pub fn of(over: &Over) -> Option<Context> {
        let line = |s: &Option<String>, max| {
            s.as_deref()
                .map(|s| one_line(s, max))
                .filter(|s| !s.is_empty())
        };
        let app = line(&over.app, APP_MAX);
        // A title that is just the app's name says nothing more.
        let title = line(&over.title, TITLE_MAX).filter(|t| app.as_ref() != Some(t));
        (app.is_some() || title.is_some()).then_some(Context { app, title })
    }

    /// The line the box shows: From Google Chrome: "Pull request #191…".
    pub fn line(&self) -> String {
        match (&self.app, &self.title) {
            (Some(app), Some(title)) => format!("From {app}: \"{title}\""),
            (Some(app), None) => format!("From {app}"),
            (None, Some(title)) => format!("From a window called \"{title}\""),
            (None, None) => String::new(),
        }
    }
}

/// What goes to Pip once the wait is over.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    pub text: String,
    pub context: Option<Context>,
    /// The conversation it continues; none starts a new one.
    pub conversation: Option<String>,
}

/// The conversation the last quick ask went to, its title as the box shows it, and when.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Thread {
    pub id: String,
    pub title: String,
    pub at: Instant,
}

impl Thread {
    /// Whether an ask at `now` still continues it.
    pub fn continues_at(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.at) < FOLLOW_UP
    }
}

/// Whether chat.send turned an ask away because the conversation it was to follow is gone, or
/// was never this PC's to write in: the kernel's not-found for a conversation, as client.rs
/// words Nook's refusal. Nothing else lets the box send it again, into a new one.
pub fn conversation_gone(error: &str) -> bool {
    error.ends_with(": Conversation not found")
}

/// A conversation's title from its first message, as Nook makes one: a line, cut short.
pub(super) fn title_of(text: &str) -> String {
    one_line(text, THREAD_TITLE_MAX)
}

/// What you typed, as it goes: trimmed, without control characters, and not endlessly long.
pub(super) fn typed(text: &str) -> String {
    let kept: String = text
        .chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(MAX_TEXT)
        .collect();
    kept.trim().to_string()
}

/// A single line of at most `max` characters: line breaks and other control characters are spaces,
/// runs of spaces one, and double quotes single, so a title can't close the quotes it's in.
fn one_line(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| match c {
            c if c.is_control() => ' ',
            '"' => '\'',
            c => c,
        })
        .collect();
    let words = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if words.chars().count() <= max {
        return words;
    }
    let cut: String = words.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// The start of Pip's answer: its first paragraph, in a line.
pub(super) fn first_words(words: &str) -> String {
    let first = words
        .split("\n\n")
        .map(str::trim)
        .find(|p| !p.is_empty())
        .unwrap_or("");
    one_line(first, WORDS_MAX)
}

/// The box on a monitor's work area (physical px, left, top, right, bottom) whose pages are drawn
/// at `dpi`: centred across it, a quarter of the way down, and never wider or taller than it.
/// The window's x, y, width and height.
pub fn box_rect(work: (i32, i32, i32, i32), dpi: u32) -> (i32, i32, i32, i32) {
    let (left, top, right, bottom) = work;
    let scaled = |px: i32| (f64::from(px) * f64::from(dpi.max(1)) / 96.0).round() as i32;
    let (w, h) = (
        scaled(BOX_SIZE.0).min(right - left),
        scaled(BOX_SIZE.1).min(bottom - top),
    );
    (
        left + (right - left - w) / 2,
        top + (bottom - top - h) / 4,
        w,
        h,
    )
}
