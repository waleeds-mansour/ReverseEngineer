// The notch's chat with Pip (chat.rs): the chat as it stands, and what each of Hearth's answers
// does to it. chat_parts.rs has the view's shapes and how an answer's pieces are read; this keeps
// the conversation shown, its lines, whether Pip is still on it, and the switcher's lists, and
// builds the view, numbered only when it changed.

use super::parts::{
    clip, line_of, status_of, ChatItem, ChatLine, ChatView, ChatWho, Page, Turns, AWAIT_FOR,
    LINE_MAX, LISTED, PAGE, TITLE_MAX,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Instant;

/// What the panel says of words Hearth didn't confirm, until they show in the conversation.
pub const UNSURE: &str =
    "Hearth didn't answer, so your message may have gone. Check before sending it again.";

/// The chat as it stands.
#[derive(Debug)]
pub struct ChatRun {
    pub open: bool,
    pub conversation: Option<String>,
    /// Counts each switch of conversation, so an answer for the one before is dropped.
    pub ver: u64,
    /// Counts each start and stop of looking for Pip's words: only the latest looks on.
    pub poll: u64,
    /// Counts each opening of the panel: only the latest watches the desk shut.
    pub watch: u64,
    pub title: String,
    /// The app started it, so the token reads it without the desk.
    pub mine: bool,
    /// Read through the desk last time.
    pub via_desk: bool,
    pub lines: Vec<ChatLine>,
    /// Lines from a whole log, older than those shown (the token's way has no paging).
    pub held: Vec<ChatLine>,
    pub older: bool,
    /// The newest log entry read: what the next look asks for after.
    pub last: i64,
    pub turns: Turns,
    pub status: Option<String>,
    /// A message sent, by its place in the log, that Pip hasn't been seen on yet.
    pub awaiting: Option<(i64, Instant)>,
    pub replies: Vec<String>,
    pub replies_outside: bool,
    pub outside: Option<String>,
    /// Needs the desk: the token was refused it.
    pub refused: bool,
    pub recent: Vec<ChatItem>,
    /// The app's own conversations this run, newest first: the switcher while the desk is shut.
    pub known: Vec<ChatItem>,
    pub trouble: Option<String>,
    /// Words sent that Hearth didn't confirm, and the newest entry read before them: they may
    /// have gone, so they aren't offered to send again, and the note goes once they show.
    pub unsure: Option<(String, i64)>,
    pub unlocking: bool,
    seq: u32,
    shown: Option<ChatView>,
}

impl ChatRun {
    pub const fn new() -> ChatRun {
        ChatRun {
            open: false,
            conversation: None,
            ver: 0,
            poll: 0,
            watch: 0,
            title: String::new(),
            mine: false,
            via_desk: false,
            lines: Vec::new(),
            held: Vec::new(),
            older: false,
            last: -1,
            turns: Turns {
                active: BTreeSet::new(),
                waiting: false,
            },
            status: None,
            awaiting: None,
            replies: Vec::new(),
            replies_outside: false,
            outside: None,
            refused: false,
            recent: Vec::new(),
            known: Vec::new(),
            trouble: None,
            unsure: None,
            unlocking: false,
            seq: 0,
            shown: None,
        }
    }

    /// Shows another conversation, or a new one: nothing of the one before stays.
    pub fn show(&mut self, conversation: Option<String>) {
        let (open, poll, ver, watch) = (self.open, self.poll, self.ver, self.watch);
        let (recent, known, unlocking) = (
            std::mem::take(&mut self.recent),
            std::mem::take(&mut self.known),
            self.unlocking,
        );
        let (seq, shown) = (self.seq, self.shown.take());
        *self = ChatRun {
            open,
            conversation,
            ver: ver + 1,
            poll: poll + 1,
            watch,
            recent,
            known,
            unlocking,
            seq,
            shown,
            ..ChatRun::new()
        };
        self.title = "New conversation".into();
    }

    /// Pip is on it, or a message sent still waits for it.
    pub fn working(&self, now: Instant) -> bool {
        self.status.is_some()
            || self.turns.busy()
            || self
                .awaiting
                .is_some_and(|(_, at)| now.saturating_duration_since(at) < AWAIT_FOR)
    }

    /// The conversation's title, how it started and what it read, from either answer's header.
    fn heading(&mut self, c: &Value) {
        if let Some(t) = c["title"].as_str() {
            self.title = clip(t, TITLE_MAX);
        }
        self.mine = c["startedVia"] == "device";
        self.outside = (!c["taintedAt"].is_null()).then(|| {
            let source = c["taintSource"].as_str().map(str::trim).unwrap_or("");
            let source = if source.is_empty() {
                "outside content"
            } else {
                source
            };
            clip(source, 80)
        });
    }

    fn ready(&mut self, next: &Value) {
        let replies = next["replies"].as_array().into_iter().flatten();
        self.replies = replies
            .filter_map(|r| r.as_str().map(|s| clip(s, 120)))
            .take(2)
            .collect();
        self.replies_outside = !self.replies.is_empty() && next["outside"] == true;
    }

    /// New lines join in their places: your message shows before Hearth has sent it back, and
    /// Pip's words from just before it may come after.
    fn append(&mut self, new: Vec<ChatLine>) {
        for line in new {
            if !self.lines.iter().any(|l| l.idx == line.idx) {
                self.lines.push(line);
            }
        }
        self.lines.sort_by_key(|l| l.idx);
    }

    /// A message sent is answered once Pip is seen on it, or something past it comes.
    fn settle(&mut self, newest: i64) {
        if let Some((idx, _)) = self.awaiting {
            if self.status.is_some() || newest > idx {
                self.awaiting = None;
            }
        }
    }

    /// desk.conversation's answer for one conversation.
    pub fn took_page(&mut self, result: &Value, how: Page) {
        self.heading(&result["conversation"]);
        let page: Vec<ChatLine> = result["log"]
            .as_array()
            .map(|l| l.iter().filter_map(line_of).collect())
            .unwrap_or_default();
        let more = result["more"] == true;
        let newest = page.last().map_or(-1, |l| l.idx);
        match how {
            Page::Newest => {
                (self.lines, self.older) = (page, more);
                self.held.clear();
            }
            Page::Older => {
                let first = self.lines.first().map_or(i64::MAX, |l| l.idx);
                let mut lines: Vec<ChatLine> = page.into_iter().filter(|l| l.idx < first).collect();
                lines.append(&mut self.lines);
                (self.lines, self.older) = (lines, more);
            }
            Page::After => self.append(page),
        }
        self.last = self.last.max(newest);
        self.turns = Turns::default();
        self.status = status_of(&result["pip"]);
        self.ready(&result["next"]);
        (self.via_desk, self.refused) = (true, false);
        // Only Pip's or Nook's words past the message say it was taken up: yours are only echoes.
        let past = self.lines.iter().rev().find(|l| l.who != ChatWho::You);
        self.settle(past.map_or(-1, |l| l.idx));
        self.seen_unsure();
    }

    /// Where words you sent show in the log past `after`, if they do.
    pub fn went(&self, text: &str, after: i64) -> Option<i64> {
        let mine = |l: &&ChatLine| l.who == ChatWho::You && l.idx > after && l.text == text;
        self.lines.iter().find(mine).map(|l| l.idx)
    }

    /// Words Hearth didn't confirm showed after all: they went, and the note goes.
    fn seen_unsure(&mut self) {
        let seen = self
            .unsure
            .as_ref()
            .is_some_and(|(text, after)| self.went(text, *after).is_some());
        if seen {
            self.unsure = None;
        }
    }

    /// Looking stopped on its own: Pip isn't shown at work any more, until a send, a switch or
    /// opening the panel again looks afresh.
    pub fn give_up(&mut self) {
        (self.status, self.awaiting, self.turns) = (None, None, Turns::default());
    }

    /// conversation.get's answer: the whole log, or what came after the newest entry read.
    pub fn took_log(&mut self, result: &Value, whole: bool) {
        self.heading(&result["conversation"]);
        let log = result["log"].as_array().cloned().unwrap_or_default();
        if whole {
            self.turns = Turns::default();
        }
        for e in &log {
            self.turns.take(e);
        }
        let lines: Vec<ChatLine> = log.iter().filter_map(line_of).collect();
        if whole {
            let cut = lines.len().saturating_sub(PAGE);
            let (held, shown) = lines.split_at(cut);
            (self.held, self.lines) = (held.to_vec(), shown.to_vec());
            self.older = !self.held.is_empty();
        } else {
            self.append(lines);
        }
        let newest = log.iter().filter_map(|e| e["idx"].as_i64()).max();
        self.last = self.last.max(newest.unwrap_or(-1));
        self.status = None;
        self.ready(&result["next"]);
        (self.via_desk, self.refused) = (false, false);
        // The log has the message itself, so its fold knows from here.
        if let Some((idx, _)) = self.awaiting {
            if newest.is_some_and(|n| n >= idx) {
                self.awaiting = None;
            }
        }
        self.seen_unsure();
    }

    /// A page further back from the lines a whole log held.
    pub fn older_from_held(&mut self) {
        let cut = self.held.len().saturating_sub(PAGE);
        let mut lines = self.held.split_off(cut);
        lines.append(&mut self.lines);
        self.lines = lines;
        self.older = !self.held.is_empty();
    }

    /// Your message went: it shows at once, and Pip is looked for on it.
    pub fn sent(&mut self, conversation: &str, idx: i64, text: &str, now: Instant) {
        if self.conversation.as_deref() != Some(conversation) {
            // A new conversation: the app started it, and Nook titles it from its first message.
            self.conversation = Some(conversation.to_string());
            self.mine = true;
            self.title = clip(text.lines().next().unwrap_or(text).trim(), 60);
        }
        self.append(vec![ChatLine {
            idx,
            who: ChatWho::You,
            text: clip(text, LINE_MAX),
        }]);
        self.awaiting = Some((idx, now));
        // You've written: the replies Pip offered answer something you've moved past (D85).
        self.replies.clear();
        (self.trouble, self.unsure) = (None, None);
        self.remember();
    }

    /// Keeps the app's own conversation for the switcher while the desk is shut.
    pub fn remember(&mut self) {
        let Some(id) = self.conversation.clone().filter(|_| self.mine) else {
            return;
        };
        self.known.retain(|k| k.id != id);
        let item = ChatItem {
            id,
            title: self.title.clone(),
            at: String::new(),
            working: false,
        };
        self.known.insert(0, item);
        self.known.truncate(LISTED);
    }

    /// The token was refused this conversation: only the desk shows it, so nothing of it stays.
    pub fn refuse(&mut self) {
        (self.lines, self.held, self.older) = (Vec::new(), Vec::new(), false);
        (self.status, self.awaiting, self.turns) = (None, None, Turns::default());
        (self.replies, self.outside, self.refused) = (Vec::new(), None, true);
    }

    /// The view as things stand, and whether it changed since the last one.
    pub fn view(&mut self, desk: bool, link: &str, now: Instant) -> (ChatView, bool) {
        // Numbered only once it's known to differ from the last.
        let mut v = ChatView {
            seq: 0,
            open: self.open,
            desk,
            unlocking: self.unlocking,
            conversation: self.conversation.clone(),
            title: self.title.clone(),
            lines: self.lines.clone(),
            older: self.older,
            working: self.working(now),
            status: None,
            replies: self.replies.clone(),
            replies_outside: self.replies_outside,
            outside: self.outside.clone(),
            locked: self.conversation.is_some() && !desk && (self.refused || !self.mine),
            recent: if desk {
                self.recent.clone()
            } else {
                self.known.clone()
            },
            link: link.to_string(),
            trouble: (self.trouble.clone()).or_else(|| self.unsure.as_ref().map(|_| UNSURE.into())),
        };
        if v.working {
            v.status = Some(self.status.clone().unwrap_or_else(|| "Thinking".into()));
        }
        // Nothing of it shows, not even its title, which is made from its first words.
        if v.locked {
            (v.lines, v.older, v.working, v.status) = (Vec::new(), false, false, None);
            (v.title, v.outside) = (String::new(), None);
            v.replies.clear();
        }
        let changed = self.shown.as_ref() != Some(&v);
        if changed {
            self.shown = Some(v.clone());
            self.seq += 1;
        }
        v.seq = self.seq;
        (v, changed)
    }
}
