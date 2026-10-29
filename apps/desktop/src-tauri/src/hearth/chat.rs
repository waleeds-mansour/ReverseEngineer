// The notch's chat with Pip, Nook's side (src/nook/chatPanel.ts is the page's, chat_parts.rs the
// view and what Hearth's answers become). Clicking Pip's mark opens a chat in the notch rather
// than Hearth's window: the owner wants Pip without opening a window they don't need.
//
// With Windows Hello's desk open (desk.rs, D84), it reads any of the owner's conversations through
// desk.conversation (D86) and sends through chat.send with the desk's secret, so it may write
// where it didn't start. Without the desk it has the app's token alone: the conversations the app
// started, read with conversation.get, and an "Unlock with Windows Hello" row for the rest. The
// desk's secret stays in desk.rs; the page never sees it.
//
// Pip's reply as it comes: Hearth's only live route, GET /api/events, is the whole event feed and
// closed to the token, so while the panel is open and Pip works the chat asks once a second for
// what came after its newest line (chat_look.rs), and stops once Pip is done, or on its own when
// looking stops paying. A look at the desk leaves no audit row; one with the token leaves
// conversation.get's, as the quick-ask box's do.

use super::client::TIMED_OUT;
use super::desk::{self, DeskError};
use super::quick_ask_parts::conversation_gone;
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[path = "chat_look.rs"]
mod look;
#[path = "chat_parts.rs"]
mod parts;
#[path = "chat_run.rs"]
mod state;

#[cfg(test)]
#[path = "chat_tests.rs"]
mod tests;

use look::{keep_looking, list, load, watch_desk};
use parts::{clip_utf16, is_id, Page, SEND_MAX};
pub use parts::{ChatItem, ChatLine, ChatView, ChatWho};
use state::ChatRun;

/// What the chat's views go out as, to the dock's window only.
pub const CHAT_EVENT: &str = "nook://chat";
/// The dock's window, where the notch is: nook's own label, so the two can't drift apart.
pub use crate::nook::dock::DOCK_LABEL as DOCK;
/// The app commands the chat panel calls: nook::may_invoke lets the dock's window call these.
pub const COMMANDS: [&str; 6] = [
    "chat_list",
    "chat_open",
    "chat_send",
    "chat_close",
    "chat_unlock",
    "chat_older",
];
/// Where "Open in Nook" goes before a conversation has started: Pip's pane in Hearth's window,
/// through the hearth:// link any program may open. That pane shows whichever conversation the
/// window last had, so once one is shown, nook_link names it instead.
pub const NOOK_LINK: &str = "hearth://open/today?jarvis";
/// How often the panel looks for Pip's words while it works, and at the desk while it's open.
const EVERY: Duration = Duration::from_secs(1);
/// How long one of Hearth's answers may take.
const WAIT: Duration = Duration::from_secs(5);
const NOT_PAIRED: &str = "Pair the app with Nook in Settings to chat with Pip.";
/// Said when a message longer than chat.send takes went cut.
const CUT: &str = "Only the first 20,000 characters went: that's the most a message holds.";

static RUN: Mutex<ChatRun> = Mutex::new(ChatRun::new());

fn run() -> MutexGuard<'static, ChatRun> {
    RUN.lock().unwrap_or_else(|e| e.into_inner())
}

/// Windows Hello's prompt is up for the chat: the dock's window losing the keyboard to it doesn't
/// close the chat (nook's dockkeys.rs).
pub fn unlocking() -> bool {
    run().unlocking
}

/// Whether the dock's window may call `command`, for nook::may_invoke.
pub fn may_call(command: &str) -> bool {
    COMMANDS.contains(&command)
}

/// Where "Open in Nook" goes: the conversation shown, in a pane of its own in Hearth's window
/// (/chat/<id>), or with none yet, Pip's pane.
pub fn nook_link(conversation: Option<&str>) -> String {
    match conversation.filter(|c| is_id(c)) {
        Some(id) => format!("hearth://open/chat/{id}"),
        None => NOOK_LINK.into(),
    }
}

/// Only the dock's window, on this app's own page, gets an answer.
fn guard(webview: &tauri::Webview) -> Result<AppHandle, String> {
    let app = webview.app_handle().clone();
    let local = webview
        .url()
        .is_ok_and(|u| crate::nook::askbox::is_local(&app, &u));
    if webview.label() != DOCK || !local {
        return Err("only the notch may chat with Pip".into());
    }
    Ok(app)
}

/// What a refusal at the desk leaves to say: a shut desk says itself with its Unlock row, and a
/// closed Windows Hello prompt needs no more than the row it was opened from.
fn trouble(e: &DeskError) -> Option<String> {
    match e {
        DeskError::Shut | DeskError::HelloClosed => None,
        _ => Some(e.says()),
    }
}

/// The view as things stand; sent to the dock's window too when it changed and `push`.
fn view(app: &AppHandle, push: bool) -> ChatView {
    let (v, changed) = {
        let mut r = run();
        let link = nook_link(r.conversation.as_deref());
        r.view(desk::is_open(), &link, Instant::now())
    };
    if push && changed {
        let _ = app.emit_to(DOCK, CHAT_EVENT, &v);
    }
    v
}

/// The view after a command: Pip's words looked for while it works.
fn answer(app: &AppHandle) -> ChatView {
    if run().working(Instant::now()) {
        keep_looking(app);
    }
    view(app, true)
}

/// The panel is open from now: the desk is watched while it is. Whether it was shut before.
fn opening(app: &AppHandle) -> bool {
    let was = std::mem::replace(&mut run().open, true);
    if !was {
        watch_desk(app);
    }
    !was
}

/// What became of words sent.
enum Sent {
    /// Hearth took them: the conversation and their place in its log.
    Took(String, i64),
    /// Hearth didn't answer, so they may have gone.
    Unsure,
}

/// chat.send: at the desk with its secret, else with the token.
async fn post(app: &AppHandle, input: Value) -> Result<Sent, String> {
    let took = |r: &Value| match (r["conversationId"].as_str(), r["idx"].as_i64()) {
        (Some(id), Some(idx)) => Sent::Took(id.to_string(), idx),
        // Hearth said yes, so it went, even though the panel can't tell where.
        _ => Sent::Unsure,
    };
    if desk::is_open() {
        match desk::act(app, "chat.send", input.clone()).await {
            Ok(r) => return Ok(took(&r)),
            Err(DeskError::Shut) => {}
            // No answer isn't a no: it may have gone.
            Err(DeskError::Offline) => return Ok(Sent::Unsure),
            Err(e) => return Err(e.says()),
        }
    }
    let h = super::link(app).ok_or(NOT_PAIRED)?;
    match h.call("chat.send", input, WAIT).await {
        Ok(r) => Ok(took(&r)),
        Err(e) if e == TIMED_OUT => Ok(Sent::Unsure),
        Err(e) if conversation_gone(&e) => Err("Unlock with Windows Hello to write here.".into()),
        Err(e) => Err(e),
    }
}

/// Sends your words through chat.send. An Err is a send that surely didn't go, so the page puts
/// the words back in the box; one that may have gone is never offered to send twice.
async fn send(app: &AppHandle, text: &str) -> Result<(), String> {
    let (words, cut) = clip_utf16(text, SEND_MAX);
    let (conversation, before) = {
        let r = run();
        (r.conversation.clone(), r.last)
    };
    let mut input = json!({ "text": words });
    if let Some(id) = &conversation {
        input["conversationId"] = json!(id);
    }
    let now = Instant::now();
    let (id, idx) = match post(app, input).await? {
        Sent::Took(id, idx) => (id, idx),
        Sent::Unsure => return unsure(app, conversation, words, before).await,
    };
    let mut r = run();
    // You switched conversation while it went: it went all the same, to the one it was for.
    if r.conversation == conversation {
        r.sent(&id, idx, &words, now);
        if cut {
            r.trouble = Some(CUT.into());
        }
    }
    Ok(())
}

/// Hearth didn't answer a send. The conversation is read again: words that show there went, and
/// words that don't come back to the box. With no conversation yet, or no answer again, they may
/// have gone, and the panel says so and keeps looking rather than offering them twice.
async fn unsure(
    app: &AppHandle,
    conversation: Option<String>,
    words: String,
    before: i64,
) -> Result<(), String> {
    let read = conversation.is_some() && load(app, Page::After).await;
    {
        let mut r = run();
        if r.conversation != conversation {
            return Ok(());
        }
        if read {
            let Some(idx) = r.went(&words, before) else {
                return Err("It didn't reach Pip, so it's back in the box.".into());
            };
            r.sent(
                conversation.as_deref().unwrap_or_default(),
                idx,
                &words,
                Instant::now(),
            );
            return Ok(());
        }
        r.unsure = Some((words, before));
    }
    if conversation.is_some() {
        keep_looking(app);
    }
    Ok(())
}

/// The panel opened: the conversation it last showed, read again, and the desk's recent
/// conversations. While it's open (the switcher asking), only the list is read again, so the
/// older lines you scrolled back through stay.
#[tauri::command]
#[specta::specta]
pub async fn chat_list(webview: tauri::Webview) -> Result<ChatView, String> {
    let app = guard(&webview)?;
    let opened = opening(&app);
    list(&app).await;
    if !opened {
        return Ok(view(&app, true));
    }
    load(&app, Page::Newest).await;
    Ok(answer(&app))
}

/// Shows a conversation from the switcher, or with none a new one, which your first message
/// starts.
#[tauri::command]
#[specta::specta]
pub async fn chat_open(
    webview: tauri::Webview,
    conversation: Option<String>,
) -> Result<ChatView, String> {
    let app = guard(&webview)?;
    run().show(conversation.filter(|c| is_id(c)));
    opening(&app);
    load(&app, Page::Newest).await;
    Ok(answer(&app))
}

/// Your words to Pip. A failure comes back as Err, so the page keeps what you typed.
#[tauri::command]
#[specta::specta]
pub async fn chat_send(webview: tauri::Webview, text: String) -> Result<ChatView, String> {
    let app = guard(&webview)?;
    let text = text.trim();
    if text.is_empty() {
        return Ok(view(&app, false));
    }
    send(&app, text).await?;
    Ok(answer(&app))
}

/// Lines older than those shown.
#[tauri::command]
#[specta::specta]
pub async fn chat_older(webview: tauri::Webview) -> Result<ChatView, String> {
    let app = guard(&webview)?;
    load(&app, Page::Older).await;
    Ok(view(&app, true))
}

/// Windows Hello opens the desk, and with it the rest of your conversations.
#[tauri::command]
#[specta::specta]
pub async fn chat_unlock(webview: tauri::Webview) -> Result<ChatView, String> {
    let app = guard(&webview)?;
    if run().unlocking {
        return Ok(view(&app, false));
    }
    run().unlocking = true;
    view(&app, true);
    let opened = desk::unlock(&app).await;
    let open = {
        let mut r = run();
        r.unlocking = false;
        r.open
    };
    // Windows Hello's prompt had the keyboard: the notch takes it back for the chat.
    if open {
        crate::nook::retake_keys(&app);
    }
    match opened {
        Ok(()) => {
            list(&app).await;
            load(&app, Page::Newest).await;
        }
        Err(e) => run().trouble = trouble(&e),
    }
    Ok(answer(&app))
}

/// The panel closed; with `nook`, the conversation shown goes on in Hearth's window, in a pane
/// of its own (nook_link), or with none yet in Pip's pane.
#[tauri::command]
#[specta::specta]
pub async fn chat_close(webview: tauri::Webview, nook: bool) -> Result<ChatView, String> {
    let app = guard(&webview)?;
    let link = {
        let mut r = run();
        r.open = false;
        r.poll += 1;
        nook_link(r.conversation.as_deref())
    };
    if nook {
        super::deeplink::handle(&app, &link);
    }
    Ok(view(&app, true))
}
