// The recording overlay's ready handshake. The overlay's page lives in a hidden webview until it
// is shown, and WebView2 holds back a hidden page's script, so a `show-overlay` sent in the same
// tick as the window shows (or before the page has started listening at all) can be lost: the
// overlay then never appears. So Rust keeps the latest show and the page answers: once when it
// listens, and once for each show it has drawn. The latest show goes out again when the page says
// it is ready, when it loads, and when a show goes unanswered; a page that still doesn't answer is
// loaded again, once per show. Each show is numbered, so the page draws it once however often it
// arrives.

use serde::Serialize;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// How long a show may go unanswered before it is sent again.
pub const ANSWER_WITHIN: Duration = Duration::from_millis(400);
/// How long after that before a page that still hasn't answered is loaded again.
pub const RELOAD_AFTER: Duration = Duration::from_millis(1600);

/// What `show-overlay` carries: the state to draw, and its number.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Show {
    pub state: String,
    pub seq: u64,
}

/// What to send the page again: the show, and `recording-ready` after it when the microphone has
/// already delivered (drawing a show resets the page to arming).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resend {
    pub show: Show,
    pub capture_ready: bool,
}

/// What an unanswered show calls for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Due {
    /// Answered, or no longer the show on screen.
    Nothing,
    Resend(Resend),
    /// Load the page again.
    Reload,
    /// It was loaded again for this show already; it stays as it is, and the log says so.
    GiveUp,
}

#[derive(Debug, Default)]
pub struct Handshake {
    seq: u64,
    /// The show on screen now; none while the overlay is hidden.
    shown: Option<Show>,
    /// The microphone delivered its first samples during the show on screen.
    capture_ready: bool,
    /// The page said it listens, since it last loaded.
    ready: bool,
    /// The last show the page said it drew.
    drawn: u64,
    /// The show the page was last loaded again for.
    reloaded_for: u64,
}

impl Handshake {
    /// The overlay shows `state`: a new show, sent at once and kept for later.
    pub fn show(&mut self, state: &str) -> Show {
        self.seq += 1;
        let show = Show {
            state: state.to_string(),
            seq: self.seq,
        };
        self.shown = Some(show.clone());
        self.capture_ready = false;
        show
    }

    pub fn hide(&mut self) {
        self.shown = None;
        self.capture_ready = false;
    }

    /// The microphone delivered its first samples.
    pub fn capture_ready(&mut self) {
        if self.shown.is_some() {
            self.capture_ready = true;
        }
    }

    /// The page answered: with None when it starts listening, having drawn nothing yet, or with
    /// the show it just drew. Starting to listen gets the latest show back.
    pub fn answered(&mut self, drawn: Option<u64>) -> Option<Resend> {
        self.ready = true;
        match drawn {
            Some(seq) => {
                self.drawn = self.drawn.max(seq);
                None
            }
            None => {
                self.drawn = 0;
                self.pending()
            }
        }
    }

    /// The page loaded (again): it has drawn nothing, and may already be listening.
    pub fn loaded(&mut self) -> Option<Resend> {
        self.ready = false;
        self.drawn = 0;
        self.pending()
    }

    /// Whether the page has said it listens since it last loaded.
    pub fn ready(&self) -> bool {
        self.ready
    }

    /// The show on screen, when the page hasn't drawn it.
    fn pending(&self) -> Option<Resend> {
        let show = self.shown.clone().filter(|s| s.seq > self.drawn)?;
        Some(Resend {
            show,
            capture_ready: self.capture_ready,
        })
    }

    /// Show `seq` was sent a while ago: send it again, or, the `last` time it is checked, load the
    /// page again, once per show.
    pub fn due(&mut self, seq: u64, last: bool) -> Due {
        let Some(resend) = self.pending().filter(|r| r.show.seq == seq) else {
            return Due::Nothing;
        };
        if !last {
            return Due::Resend(resend);
        }
        if self.reloaded_for == seq {
            return Due::GiveUp;
        }
        self.reloaded_for = seq;
        self.ready = false;
        Due::Reload
    }
}

static HANDSHAKE: Mutex<Handshake> = Mutex::new(Handshake {
    seq: 0,
    shown: None,
    capture_ready: false,
    ready: false,
    drawn: 0,
    reloaded_for: 0,
});

/// The overlay's one handshake. Never held while emitting or touching the window.
pub fn handshake() -> MutexGuard<'static, Handshake> {
    HANDSHAKE.lock().unwrap_or_else(|p| p.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resend(state: &str, seq: u64, capture_ready: bool) -> Option<Resend> {
        Some(Resend {
            show: Show {
                state: state.into(),
                seq,
            },
            capture_ready,
        })
    }

    #[test]
    fn a_page_that_starts_listening_late_gets_the_latest_show() {
        let mut h = Handshake::default();
        // The show went out while the page wasn't listening yet, and was lost.
        let first = h.show("recording");
        assert_eq!(first.seq, 1);
        h.capture_ready();
        assert!(!h.ready());
        assert_eq!(h.answered(None), resend("recording", 1, true));
        assert!(h.ready());
        // It drew it: nothing more to send.
        assert_eq!(h.answered(Some(1)), None);
        assert_eq!(h.due(1, false), Due::Nothing);
    }

    #[test]
    fn only_the_latest_show_is_sent_again() {
        let mut h = Handshake::default();
        h.show("recording");
        h.show("transcribing");
        assert_eq!(h.answered(None), resend("transcribing", 2, false));
        assert_eq!(h.due(1, false), Due::Nothing, "show 1 was replaced");
        assert_eq!(
            h.due(2, false),
            Due::Resend(resend("transcribing", 2, false).unwrap())
        );
    }

    #[test]
    fn a_hidden_overlay_sends_nothing_again() {
        let mut h = Handshake::default();
        h.show("streaming");
        h.capture_ready();
        h.hide();
        assert_eq!(h.answered(None), None);
        assert_eq!(h.loaded(), None);
        assert_eq!(h.due(1, true), Due::Nothing);
        // Samples that arrive after the overlay hid don't carry into the next show.
        h.capture_ready();
        h.show("recording");
        assert_eq!(h.answered(None), resend("recording", 2, false));
    }

    #[test]
    fn a_page_that_loads_again_has_drawn_nothing() {
        let mut h = Handshake::default();
        h.show("recording");
        assert_eq!(h.answered(Some(1)), None);
        assert_eq!(h.loaded(), resend("recording", 1, false));
        assert!(!h.ready());
    }

    #[test]
    fn an_unanswered_show_is_sent_again_then_its_page_loaded_again_once() {
        let mut h = Handshake::default();
        h.answered(None);
        h.show("recording");
        assert_eq!(
            h.due(1, false),
            Due::Resend(resend("recording", 1, false).unwrap())
        );
        assert_eq!(h.due(1, true), Due::Reload);
        assert!(!h.ready(), "a page loading again listens for nothing yet");
        assert_eq!(h.due(1, true), Due::GiveUp, "once per show");
        // The next show may load the page again.
        h.show("transcribing");
        assert_eq!(h.due(2, true), Due::Reload);
        // An answer that comes in the end settles it.
        h.answered(Some(2));
        assert_eq!(h.due(2, true), Due::Nothing);
    }

    #[test]
    fn the_show_reads_as_the_page_expects() {
        let mut h = Handshake::default();
        let json = serde_json::to_value(h.show("processing")).unwrap();
        assert_eq!(json, serde_json::json!({ "state": "processing", "seq": 1 }));
    }
}
