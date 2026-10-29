// Notifications from Hearth (D53): the inbox items your phone is told about (approvals, the
// morning brief, interruptions Jarvis may make, Pip's questions and finished work) and Hearth's
// health changing. The app keeps one stream open to GET /api/desktop/notify and shows each
// message, unless Hearth's window is in front. While Nook's agent dock shows, a new desk card
// pops up in the dock's notch instead of as a Windows notification, with the feed's heading only,
// and a click there opens the Inbox at it; while the dock is hidden for a game or something fullscreen nothing pops, and the
// card waits in the Inbox with the dock's badge; with the dock off it is a Windows notification
// as before, whose click opens its page in Hearth's window. Finished work comes quietly (D84):
// never as a Windows notification. The same stream says what Pip is doing, how many things wait
// for the owner's yes and how Hearth's parts are, for the dock (nook/live.rs), whenever that
// changes; when it closes, the dock stops counting on it. Nothing here can approve anything: the
// device token can't, and a notification only opens a page.

use super::client::Hearth;
use super::sse::Reader;
use super::{link, links, toast, window};
#[cfg(windows)]
use crate::nook::dock::DOCK_LABEL;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Not even a keep-alive (Hearth sends one every 20 s) for this long: the stream is dead.
const SILENCE: Duration = Duration::from_secs(70);
const FIRST_WAIT: Duration = Duration::from_secs(5);
const LONGEST_WAIT: Duration = Duration::from_secs(5 * 60);

/// The agent dock is Windows' only; elsewhere its window is never there to find.
#[cfg(not(windows))]
const DOCK_LABEL: &str = "nook_dock";

/// A new card for the dock's notch, to its window only.
pub const NOTICE_EVENT: &str = "nook://dock-notice";

/// The desk's kinds of card (inboxview.rs): only these have a card in the Inbox to open at.
const CARD_KINDS: [&str; 5] = ["approval", "question", "finished", "brief", "wrap"];

#[derive(Debug, Deserialize, PartialEq)]
pub struct Message {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub url: String,
    /// The inbox item's id, which is its desk card's (a health change's own tag).
    #[serde(default)]
    pub tag: String,
    /// Which card came: approval, question, finished, brief or wrap; health for Hearth's parts.
    #[serde(default)]
    pub kind: String,
    /// On the desk, but no Windows notification: finished work.
    #[serde(default)]
    pub quiet: bool,
}

/// Where the agent dock is as a message comes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dock {
    Shows,
    /// Hidden for a game, something fullscreen, or a rest from its menu.
    Hidden,
    Off,
}

/// What a message does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// A notice in the dock's notch.
    Notice,
    /// Nothing pops: it waits in the Inbox, and on the bar's Pip chip.
    Wait,
    /// A Windows notification.
    Toast,
    /// Hearth's window is in front, where it shows anyway.
    Nothing,
}

/// The dock's notice: the card's id and kind, and the feed's heading, which never carries a
/// question's words. The desk isn't asked for the card: every desk call keeps an unattended desk
/// open longer, and the notice says what the card is only when the Inbox's own view has it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Notice {
    pub id: String,
    pub kind: String,
    pub heading: String,
}

/// Where a message goes. Hearth's health isn't a desk card: the dock's own dot says it, and the
/// Windows notification says where to look, as before.
pub fn route(m: &Message, dock: Dock, hearth_in_front: bool) -> Route {
    if hearth_in_front {
        return Route::Nothing;
    }
    let card = !m.tag.is_empty() && CARD_KINDS.contains(&m.kind.as_str());
    match dock {
        Dock::Shows if card => Route::Notice,
        Dock::Hidden if card => Route::Wait,
        _ if m.quiet || m.kind == "finished" => Route::Wait,
        _ => Route::Toast,
    }
}

/// Starts listening. Call once at startup; it waits quietly while the app isn't connected.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_id: Option<String> = None;
        let mut wait = FIRST_WAIT;
        loop {
            let Some(h) = link(&app) else {
                tokio::time::sleep(Duration::from_secs(15)).await;
                continue;
            };
            let started = Instant::now();
            if let Err(e) = listen(&app, &h, &mut last_id).await {
                log::debug!("Notifications: {e}");
            }
            crate::nook::live_status(&app, None);
            wait = next_wait(wait, started.elapsed());
            tokio::time::sleep(wait).await;
        }
    });
}

/// How long to wait before connecting again: soon after a stream that ran a while, longer and
/// longer while Hearth keeps refusing or isn't there.
pub fn next_wait(previous: Duration, lasted: Duration) -> Duration {
    if lasted > Duration::from_secs(60) {
        FIRST_WAIT
    } else {
        (previous * 2).min(LONGEST_WAIT)
    }
}

async fn listen(app: &AppHandle, h: &Hearth, last_id: &mut Option<String>) -> Result<(), String> {
    let res = h.notify_feed(last_id.as_deref()).await?;
    let mut body = res.bytes_stream();
    let mut reader = Reader::default();
    loop {
        let chunk = match tokio::time::timeout(SILENCE, body.next()).await {
            Err(_) => return Err("the stream went quiet".into()),
            Ok(None) => return Ok(()),
            Ok(Some(Err(e))) => return Err(e.to_string()),
            Ok(Some(Ok(chunk))) => chunk,
        };
        for event in reader.push(&chunk) {
            if let Some(id) = &event.id {
                *last_id = Some(id.clone());
            }
            if event.event == "status" {
                match crate::nook::live::parse(&event.data) {
                    Some(status) => crate::nook::live_status(app, Some(status)),
                    None => log::warn!("Notifications: odd status from Hearth"),
                }
                continue;
            }
            if event.event != "notify" {
                continue;
            }
            match serde_json::from_str::<Message>(&event.data) {
                Ok(m) => deliver(app, m),
                Err(e) => log::warn!("Notifications: odd message from Hearth: {e}"),
            }
        }
    }
}

/// Where the agent dock is now. Its window exists only while its switch is on.
fn dock(app: &AppHandle) -> Dock {
    if crate::nook::dock::showing(app) {
        Dock::Shows
    } else if app.get_webview_window(DOCK_LABEL).is_some() {
        Dock::Hidden
    } else {
        Dock::Off
    }
}

fn deliver(app: &AppHandle, m: Message) {
    let way = route(&m, dock(app), window::main_focused(app));
    if way == Route::Nothing {
        return;
    }
    // It waits on the Pip chip in Nook's bar too, until Hearth's window is seen, and an open
    // Inbox lists the desk again.
    crate::nook::pip_notified(app);
    match way {
        Route::Toast => toast::show(app, &m.title, &m.body, Some(&links::open_link(&m.url))),
        Route::Notice => {
            let _ = app.emit_to(DOCK_LABEL, NOTICE_EVENT, notice(m));
        }
        Route::Wait | Route::Nothing => {}
    }
}

/// The notice for a message the dock pops up.
pub fn notice(m: Message) -> Notice {
    Notice {
        id: m.tag,
        kind: m.kind,
        heading: m.title,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(kind: &str, quiet: bool) -> Message {
        Message {
            title: "Pip asks you something".into(),
            body: String::new(),
            url: "/inbox".into(),
            tag: "n1".into(),
            kind: kind.into(),
            quiet,
        }
    }

    #[test]
    fn backs_off_while_hearth_is_away() {
        let quick = Duration::from_secs(1);
        assert_eq!(next_wait(FIRST_WAIT, quick), Duration::from_secs(10));
        assert_eq!(next_wait(Duration::from_secs(200), quick), LONGEST_WAIT);
        assert_eq!(
            next_wait(LONGEST_WAIT, Duration::from_secs(3600)),
            FIRST_WAIT
        );
    }

    #[test]
    fn reads_hearths_messages() {
        let m: Message = serde_json::from_str(
            r#"{"title":"Jarvis needs a yes","body":"Send it?","url":"/inbox","tag":"x","kind":"approval"}"#,
        )
        .unwrap();
        assert_eq!(links::open_link(&m.url), "hearth://open/inbox");
        assert_eq!(
            (m.tag.as_str(), m.kind.as_str(), m.quiet),
            ("x", "approval", false)
        );
        let bare: Message = serde_json::from_str(r#"{"title":"Hi"}"#).unwrap();
        assert_eq!(links::open_link(&bare.url), "hearth://open/inbox");
        let done: Message = serde_json::from_str(
            r#"{"title":"Pip finished something","body":"","url":"/inbox","tag":"f","kind":"finished","quiet":true}"#,
        )
        .unwrap();
        assert!(done.quiet);
    }

    #[test]
    fn a_new_card_pops_in_the_dock_waits_while_it_hides_and_is_a_toast_with_it_off() {
        let ask = message("question", false);
        assert_eq!(route(&ask, Dock::Shows, false), Route::Notice);
        assert_eq!(route(&ask, Dock::Hidden, false), Route::Wait);
        assert_eq!(route(&ask, Dock::Off, false), Route::Toast);
        // Hearth's window in front shows it already.
        for dock in [Dock::Shows, Dock::Hidden, Dock::Off] {
            assert_eq!(route(&ask, dock, true), Route::Nothing);
        }
        // Finished work pops in the dock, but is never a Windows notification.
        let done = message("finished", true);
        assert_eq!(route(&done, Dock::Shows, false), Route::Notice);
        assert_eq!(route(&done, Dock::Off, false), Route::Wait);
        // Even from a Hearth that forgot to say it's quiet.
        assert_eq!(
            route(&message("finished", false), Dock::Off, false),
            Route::Wait
        );
        // Hearth's health has no card to open at: a Windows notification, dock or not.
        let health = message("health", false);
        assert_eq!(route(&health, Dock::Shows, false), Route::Toast);
        assert_eq!(route(&health, Dock::Hidden, false), Route::Toast);
        // An older Hearth that doesn't say which card came: as before.
        let unsaid = Message {
            tag: String::new(),
            ..message("", false)
        };
        assert_eq!(route(&unsaid, Dock::Shows, false), Route::Toast);
    }

    #[test]
    fn a_notice_carries_the_heading_and_never_the_body() {
        let m = Message {
            body: "Which room for Thursday?".into(),
            ..message("question", false)
        };
        assert_eq!(
            serde_json::to_value(notice(m)).unwrap(),
            serde_json::json!({ "id": "n1", "kind": "question", "heading": "Pip asks you something" })
        );
    }
}
