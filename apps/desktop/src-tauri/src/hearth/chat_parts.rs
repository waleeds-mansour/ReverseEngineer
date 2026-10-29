// The notch's chat with Pip (chat.rs), in the parts that need neither Tauri nor Hearth: the view the
// page draws, what Hearth's answers become in it, and whether Pip is still working.
//
// A conversation is read one of two ways. With the desk open, desk.conversation (D86) gives a page
// of lines, the newest 50, a page further back or what came after a line, with what Pip is doing
// there; it reads any of the owner's conversations. Without it, the app's token reads only the
// conversations it started, through conversation.get, which gives the whole log (or what came
// after an entry): here its turn marks are folded, as Nook's window folds them, to know whether
// Pip is working. Either way a line is your words, Pip's, or a notice, cut to what the page shows,
// so nothing Hearth sends can make the panel draw more than a conversation's worth.

use serde::Serialize;
use serde_json::Value;
use specta::Type;
use std::collections::BTreeSet;
use std::time::{Duration, Instant};

/// The lines in one page, as desk.conversation gives them.
pub const PAGE: usize = 50;
/// The most of one line the page gets; Nook's window has all of it.
pub const LINE_MAX: usize = 20_000;
/// The longest title shown.
pub const TITLE_MAX: usize = 120;
/// How many conversations the switcher lists.
pub const LISTED: usize = 20;
/// How long a message sent waits for Pip to be seen on it before the panel stops looking.
pub const AWAIT_FOR: Duration = Duration::from_secs(90);
/// The longest message chat.send takes, counted as Hearth counts it: in UTF-16 units.
pub const SEND_MAX: usize = 20_000;
/// Looking goes on this long after Pip is done, for the ready replies that follow its turn.
pub const TAIL: Duration = Duration::from_secs(6);
/// Looks that fail in a row before the panel stops looking on its own.
pub const MISSES: u32 = 5;
/// How long Pip may seem at work with no new line before the panel stops looking: each look at
/// the desk counts as using it, so a stuck turn mustn't keep the desk open to its 8-hour cap.
pub const STALL: Duration = Duration::from_secs(5 * 60);

/// Who said a line.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum ChatWho {
    You,
    Pip,
    /// A note of Nook's in the conversation: stopped, picked up again.
    Notice,
    /// Pip's turn failed.
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct ChatLine {
    /// Its place in the conversation's log.
    pub idx: i64,
    pub who: ChatWho,
    pub text: String,
}

/// A conversation in the switcher.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct ChatItem {
    pub id: String,
    pub title: String,
    /// When it last moved, as an ISO time; empty when not known.
    pub at: String,
    pub working: bool,
}

/// What the chat panel draws, sent as 'nook://chat' to the dock's window and given back by each
/// chat command.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct ChatView {
    /// Counts up with each view that changed, so the page drops one that comes late.
    pub seq: u32,
    pub open: bool,
    /// Windows Hello has the desk open, so any of your conversations can be shown.
    pub desk: bool,
    /// Windows Hello is up.
    pub unlocking: bool,
    /// The conversation shown; None for a new one, which your first message starts.
    pub conversation: Option<String>,
    pub title: String,
    /// Oldest first.
    pub lines: Vec<ChatLine>,
    /// Older lines can be had.
    pub older: bool,
    /// Pip is on it: the working arc and `status` show.
    pub working: bool,
    /// "Thinking about what you asked", as the dock says it.
    pub status: Option<String>,
    /// Up to two ready replies (D85).
    pub replies: Vec<String>,
    /// Written after Pip read outside content: marked, as the Inbox marks them.
    pub replies_outside: bool,
    /// It read outside content, and this says what, as Nook's badge does.
    pub outside: Option<String>,
    /// It isn't the app's own and the desk is shut: Windows Hello opens it.
    pub locked: bool,
    /// The switcher: the desk's recent conversations, or without it the app's own.
    pub recent: Vec<ChatItem>,
    /// Where "Open in Nook" goes.
    pub link: String,
    /// What went wrong, plainly.
    pub trouble: Option<String>,
}

/// Which page of lines an answer is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Newest,
    Older,
    After,
}

/// At most `max` characters, cut on a character boundary.
pub fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

/// At most `max` UTF-16 units of `s`, cut on a character boundary, and whether it was cut: what
/// chat.send's limit counts, so a message of emoji isn't refused for being twice as long.
pub fn clip_utf16(s: &str, max: usize) -> (String, bool) {
    let mut used = 0;
    for (at, c) in s.char_indices() {
        used += c.len_utf16();
        if used > max {
            return (s[..at].to_string(), true);
        }
    }
    (s.to_string(), false)
}

/// Whether `s` is shaped like one of Hearth's ids (a UUID), so nothing else goes to Hearth as one.
pub fn is_id(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// A line from a log entry, or None for what isn't a line (Pip's tool calls, turn marks).
pub fn line_of(entry: &Value) -> Option<ChatLine> {
    let idx = entry["idx"].as_i64()?;
    let p = &entry["payload"];
    let (who, text) = match entry["kind"].as_str()? {
        "user_message" => (ChatWho::You, p["text"].as_str()?),
        "assistant_message" => (ChatWho::Pip, p["text"].as_str()?),
        "notice" => (ChatWho::Notice, p["text"].as_str()?),
        "error" => (
            ChatWho::Error,
            p["message"].as_str().unwrap_or("Something went wrong"),
        ),
        _ => return None,
    };
    let text = clip(text.trim(), LINE_MAX);
    (!text.is_empty()).then_some(ChatLine { idx, who, text })
}

/// Whether Pip is working, from a log's entries as Nook's window folds them: a message of yours it
/// hasn't started on, or a turn started and not yet ended.
#[derive(Clone, Debug, Default)]
pub struct Turns {
    pub(super) active: BTreeSet<String>,
    pub(super) waiting: bool,
}

impl Turns {
    pub fn take(&mut self, entry: &Value) {
        let turn = entry["turnId"].as_str();
        let running = turn.is_some_and(|t| self.active.contains(t));
        match entry["kind"].as_str().unwrap_or_default() {
            "user_message" if turn.is_none() => self.waiting = true,
            "turn_started" => {
                self.waiting = false;
                self.active.extend(turn.map(str::to_string));
            }
            "turn_finished" => {
                turn.map(|t| self.active.remove(t));
            }
            "error" => {
                if !running {
                    self.waiting = false;
                }
                turn.map(|t| self.active.remove(t));
            }
            // Retry was pressed: that turn waits for Pip again, like something you said.
            "notice" if entry["payload"]["retrying"] == true => self.waiting = true,
            "notice" if !running => self.waiting = false,
            _ => {}
        }
    }

    pub fn busy(&self) -> bool {
        self.waiting || !self.active.is_empty()
    }
}

/// What looking for Pip's words does after a look.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Next {
    Again,
    /// Pip is done, and its ready replies have had time to come.
    Done,
    /// Hearth kept failing, or Pip seemed at work with nothing new for too long.
    GiveUp,
}

/// Whether to look again, from what each look found: it stops on its own after MISSES failed
/// looks in a row, or when Pip seems at work with no new line for STALL.
#[derive(Debug)]
pub struct Looking {
    misses: u32,
    newest: i64,
    moved: Instant,
    quiet: Option<Instant>,
}

impl Looking {
    /// Looking starts, with `newest` the newest entry read so far.
    pub fn new(newest: i64, now: Instant) -> Looking {
        Looking {
            misses: 0,
            newest,
            moved: now,
            quiet: None,
        }
    }

    /// After a look: `read` whether Hearth answered it, `newest` the newest entry read since,
    /// `working` whether Pip is on it.
    pub fn after(&mut self, read: bool, newest: i64, working: bool, now: Instant) -> Next {
        if !read {
            self.misses += 1;
            return if self.misses >= MISSES {
                Next::GiveUp
            } else {
                Next::Again
            };
        }
        self.misses = 0;
        if newest > self.newest {
            (self.newest, self.moved) = (newest, now);
        }
        if working {
            self.quiet = None;
            if now.saturating_duration_since(self.moved) >= STALL {
                return Next::GiveUp;
            }
        } else if now.saturating_duration_since(*self.quiet.get_or_insert(now)) >= TAIL {
            return Next::Done;
        }
        Next::Again
    }
}

/// What the dock says Pip is doing, from desk.conversation's `pip`: None while it rests.
pub fn status_of(pip: &Value) -> Option<String> {
    let (verb, alone) = match pip["state"].as_str()? {
        "thinking" => ("Thinking about", "Thinking"),
        "working" => ("Working on", "Working"),
        _ => return None,
    };
    let label = pip["label"]
        .as_str()
        .map(str::trim)
        .filter(|l| !l.is_empty());
    Some(match label {
        Some(l) => format!("{verb} {}", clip(l, 80)),
        None => alone.to_string(),
    })
}

/// The switcher's conversations from desk.conversation's list.
pub fn items_of(result: &Value) -> Vec<ChatItem> {
    let Some(all) = result["conversations"].as_array() else {
        return Vec::new();
    };
    all.iter()
        .filter_map(|c| {
            Some(ChatItem {
                id: c["id"].as_str()?.to_string(),
                title: clip(c["title"].as_str().unwrap_or("Conversation"), TITLE_MAX),
                at: clip(c["at"].as_str().unwrap_or_default(), 40),
                working: c["working"] == true,
            })
        })
        .take(LISTED)
        .collect()
}
