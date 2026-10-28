// The quick-ask box's window and its one command; quick_ask_flow.rs decides what it does. Its
// shortcut (Ask Pip, Ctrl+Alt+K unless changed in Settings), or a double-tap of Ctrl
// (double_tap.rs), reads the window in front before the box takes the focus, and brings the box
// up over it: borderless, always on top, out of the taskbar, centred on that window's monitor and
// sized as WebView2 draws its page there (Nook's drawn_dpi). Over a game or something fullscreen,
// as the dock judges it or as nook-wm's game guard would judge the window in front (a borderless
// game too, by its class or folder), it stays away; the shortcut says so, a double-tap of Ctrl,
// which games use, says nothing. Its page is bundled with this app, gets Nook's capability
// (listening for its view and nothing more) and may call ask_pip alone (nook::may_invoke); Nook
// counts its window as one of its own. A message goes the way talk mode's words do, chat.send
// with this PC's device token, so the token can do nothing it couldn't before; where it was asked
// goes as chat.send's context, and a follow-up goes into the conversation it follows, or a new
// one when Nook says that one is gone. Clicking
// elsewhere puts the box away, as quick capture's, and throws away what its mic was hearing; a
// send already waiting still goes, and a notification says how it went while the box is away.

use super::client::{replies, Hearth, Sent, TIMED_OUT};
use super::quick_ask_flow::{AskCmd, AskMic, AskView, Flow, SENT, UNDO_FOR};
use super::quick_ask_parts::{box_rect, conversation_gone, Outgoing, Over, BOX_SIZE};
use super::quick_ask_talk as talk;
pub use super::quick_ask_win::hwnd;
use super::quick_ask_win::{give_back, spot};
use super::{foreground, toast};
use crate::nook::askbox;
use crate::nook::view::DockPage;
use crate::nook::PipMood;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "nook_ask";
const PAGE: &str = "src/nook/ask.html";
/// The view, sent to the box's page whenever it changes.
pub const VIEW_EVENT: &str = "nook://ask";
/// How long the box waits for Pip's first words back before leaving "Sent to Pip".
const LISTEN_FOR: Duration = Duration::from_secs(30);
/// What a send that timed out says: Nook may have it, so the box doesn't send it again itself.
const MAYBE_SENT: &str = "It may have reached Pip. Check the conversation before sending again.";

static FLOW: Mutex<Flow> = Mutex::new(Flow::new());
/// Held while the window is made, so a shortcut pressed twice makes it only once.
static MAKING: Mutex<()> = Mutex::new(());

pub(super) fn flow() -> MutexGuard<'static, Flow> {
    FLOW.lock().unwrap_or_else(|p| p.into_inner())
}

/// Its shortcut: the box comes up over the app in front, which it remembers.
pub fn open(app: &AppHandle) {
    open_over(app, true);
}

/// A double-tap of Ctrl: as its shortcut, but quiet over a game. Held down on the second tap,
/// the box opens listening, until Ctrl is let go.
pub fn open_by_tap(app: &AppHandle, held: bool) {
    if open_over(app, false) && held {
        talk::start(app, true);
    }
}

/// Whether the box opens: not away from Windows, nor over a game or something fullscreen.
fn open_over(app: &AppHandle, say_why: bool) -> bool {
    if !cfg!(windows) {
        log::info!("The quick-ask box opens on Windows only");
        return false;
    }
    let front = foreground::front();
    let game = front
        .as_ref()
        .is_some_and(|f| askbox::game_window(f.hwnd, f.path.as_deref()));
    if game || askbox::game_in_front(app) {
        if say_why {
            let why = "Ask Pip waits while a game or something fullscreen is in front.";
            toast::show(app, "Ask Pip", why, None);
        }
        return false;
    }
    let over = front.and_then(|f| over_of(app, f));
    flow().opened(over);
    let app = app.clone();
    // Off the shortcut's thread: making a WebView2 window there can deadlock (window.rs).
    tauri::async_runtime::spawn_blocking(move || show(&app));
    true
}

/// The window in front as the box remembers it; None when that is the box itself. Nook's own
/// windows get the focus back too, but are nothing to tell Pip.
fn over_of(app: &AppHandle, f: foreground::Front) -> Option<Over> {
    if hwnd(app) == Some(f.hwnd) {
        return None;
    }
    let ours = f.pid == std::process::id();
    let name = |p: &str| {
        askbox::app_name(p)
            .or_else(|| foreground::program_name(p).map(|n| n.trim_end_matches(".exe").to_string()))
    };
    Some(Over {
        hwnd: f.hwnd,
        pid: f.pid,
        app: f.path.as_deref().filter(|_| !ours).and_then(name),
        title: f.title.filter(|_| !ours),
    })
}

fn show(app: &AppHandle) {
    let made = app.get_webview_window(LABEL).is_none();
    let Some(window) = window(app) else {
        super::tell(
            app,
            "Couldn't open the Ask Pip box. Try its shortcut again.",
        );
        return;
    };
    if made {
        askbox::made(app);
    }
    let at = flow().over().map(|o| o.hwnd);
    let rect = spot(at).map(|(work, dpi)| box_rect(work, askbox::drawn_dpi(dpi)));
    let _ = app.run_on_main_thread(move || {
        if let Some((x, y, w, h)) = rect {
            let _ = window.set_position(PhysicalPosition::new(x, y));
            let _ = window.set_size(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
        }
        let _ = window.show();
        let _ = window.set_focus();
    });
    emit(app);
}

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let _one = MAKING.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let nav = app.clone();
    let (w, h) = BOX_SIZE;
    let mut b = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App(PAGE.into()))
        .title("Ask Pip")
        .inner_size(f64::from(w), f64::from(h))
        .center()
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        // The box stays on its own page; it has no links to follow.
        .on_navigation(move |to| askbox::is_local(&nav, to));
    if let Some(dir) = crate::portable::data_dir() {
        b = b.data_directory(dir.join("webview"));
    }
    b.build()
        .inspect_err(|e| log::warn!("Couldn't make the quick-ask box: {e}"))
        .ok()
}

/// The view as it is now, with Nook's theme, and the mic busy while another recording has it.
fn view(app: &AppHandle, now: Instant) -> AskView {
    let taken = talk::mic_taken(app);
    let mut v = {
        let flow = flow();
        let mut v = flow.view(now);
        if flow.mic_busy(taken) {
            v.mic = AskMic::Busy;
        }
        v
    };
    v.chrome = askbox::chrome(app);
    v
}

pub(super) fn emit(app: &AppHandle) {
    let v = view(app, Instant::now());
    if let Err(e) = app.emit_to(LABEL, VIEW_EVENT, v) {
        log::debug!("Couldn't tell the quick-ask box: {e}");
    }
}

/// Clicking elsewhere puts the box away; whatever waits to be sent still goes, and what the mic
/// was hearing is thrown away.
pub fn blurred(window: &tauri::Window) {
    talk::stop(window.app_handle(), false);
    let _ = window.hide();
}

fn hide(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

/// Whether the box is out of sight, so how a send went is told in a notification.
fn away(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .is_none_or(|w| !w.is_visible().unwrap_or(false))
}

/// Esc: the app the box opened over gets the focus back, and the box goes away.
fn close(app: &AppHandle) {
    talk::stop(app, false);
    let over = flow().over().cloned();
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    let _ = app.run_on_main_thread(move || {
        // While the box is still in front, so Windows lets this app give the foreground away.
        if let Some(o) = over {
            give_back(&o);
        }
        let _ = w.hide();
    });
}

/// The quick-ask box's one command. Only its own window, on this app's own page, gets an answer.
#[tauri::command]
#[specta::specta]
pub async fn ask_pip(webview: tauri::Webview, cmd: AskCmd) -> Result<AskView, String> {
    let app = webview.app_handle().clone();
    let local = webview.url().is_ok_and(|u| askbox::is_local(&app, &u));
    if webview.label() != LABEL || !local {
        return Err("only the quick-ask box may ask this".into());
    }
    let now = Instant::now();
    match cmd {
        AskCmd::Ready => {}
        AskCmd::Send { text } => {
            // None: one already waits or goes, and a second Enter does nothing.
            let id = flow().send(&text, now)?;
            if let Some(id) = id {
                wait_then_send(&app, id);
            }
        }
        // Too late, the view says so.
        AskCmd::Undo => {
            flow().undo();
        }
        AskCmd::DropContext => flow().drop_context(),
        AskCmd::Close => close(&app),
        AskCmd::OpenConversation => {
            askbox::open_page(&app, DockPage::Conversation);
            hide(&app);
        }
        AskCmd::Listen => talk::start(&app, false),
        AskCmd::StopListening { keep } => talk::stop(&app, keep),
        AskCmd::Fresh => flow().toggle_fresh(now),
    }
    Ok(view(&app, now))
}

/// After UNDO_FOR, unless it was undone, the message goes to Pip; then the box listens a while
/// for Pip's first words back.
fn wait_then_send(app: &AppHandle, id: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(UNDO_FOR).await;
        let due = flow().due(id);
        let Some(out) = due else {
            return;
        };
        emit(&app);
        let Some(h) = super::link(&app) else {
            return failed(&app, id, "Pair the app with Nook in Settings to use Pip.");
        };
        crate::nook::pip(&app, PipMood::Thinking);
        match send(&h, &out).await {
            Ok(sent) => {
                let took = flow().sent(id, &sent.conversation_id, Instant::now());
                if !took {
                    return crate::nook::pip(&app, PipMood::Idle);
                }
                emit(&app);
                if away(&app) {
                    let link = askbox::page_link(DockPage::Conversation);
                    let said = flow().view(Instant::now()).note;
                    let title = said.as_deref().unwrap_or(SENT);
                    toast::show(&app, title, &out.text, link.as_deref());
                }
                listen(&app, &h, id, sent).await;
            }
            // It may have gone all the same: the box doesn't send it again on its own.
            Err(e) if e == TIMED_OUT => failed(&app, id, MAYBE_SENT),
            Err(e) => failed(&app, id, &e),
        }
    });
}

/// chat.send, into the conversation it follows; when Nook says that one is gone, into a new one,
/// which the box then says. Any other failure is the box's to tell, the text back in it.
async fn send(h: &Hearth, out: &Outgoing) -> Result<Sent, String> {
    let context = || {
        out.context
            .as_ref()
            .and_then(|c| serde_json::to_value(c).ok())
    };
    let into = out.conversation.as_deref();
    match h.send_with(&out.text, into, context()).await {
        Err(e) if into.is_some() && conversation_gone(&e) => {
            log::info!("Quick ask: its conversation didn't take it ({e}); starting a new one");
            h.send_with(&out.text, None, context()).await
        }
        r => r,
    }
}

/// Pip's first words back show in the box while it shows this message. Pip looks happy once its
/// turn ends, and idle again if the box stops listening before then.
async fn listen(app: &AppHandle, h: &Hearth, id: u64, sent: Sent) {
    let mut after = sent.idx;
    let deadline = Instant::now() + LISTEN_FOR;
    let (mut heard, mut ended) = (false, false);
    while !ended && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let showing = flow().showing(id);
        if !showing {
            break;
        }
        let Ok(log) = h.log_after(&sent.conversation_id, after).await else {
            continue;
        };
        if let Some(last) = log.last() {
            after = last.idx;
        }
        let (said, done) = replies(&log);
        if let Some(words) = said.first().filter(|_| !heard) {
            heard = true;
            let took = flow().answered(id, words);
            if took {
                emit(app);
            }
        }
        ended = done;
    }
    let mood = if ended { PipMood::Happy } else { PipMood::Idle };
    crate::nook::pip(app, mood);
}

fn failed(app: &AppHandle, id: u64, why: &str) {
    let took = flow().failed(id, why);
    crate::nook::pip(app, PipMood::Idle);
    if !took {
        return;
    }
    emit(app);
    if away(app) {
        let body = format!("{why} What you typed is back in the Ask Pip box.");
        toast::show(app, "Pip didn't get that", &body, None);
    }
}
