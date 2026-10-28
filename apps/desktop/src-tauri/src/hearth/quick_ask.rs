// The quick-ask box's window and its one command; quick_ask_flow.rs decides what it does. Its
// shortcut (Ask Pip, Ctrl+Alt+K unless changed in Settings) reads the window in front before the
// box takes the focus, and brings the box up over it: borderless, always on top, out of the
// taskbar, centred on that window's monitor and sized as WebView2 draws its page there (Nook's
// drawn_dpi). Over a game or something fullscreen, as the dock judges it, it reads nothing and
// stays away. Its page is bundled with this app, gets Nook's capability (listening for its view
// and nothing more) and may call ask_pip alone (nook::may_invoke); Nook counts its window as one
// of its own. A message goes the way talk mode's words do, chat.send with this PC's device token,
// so the token can do nothing it couldn't before; where it was asked goes as chat.send's context.
// Clicking elsewhere puts the box away, as quick capture's; a send already waiting still goes,
// and a notification says how it went while the box is away.

use super::client::{replies, Hearth, Sent, TIMED_OUT};
use super::quick_ask_flow::{AskCmd, AskView, Flow, SENT, UNDO_FOR};
use super::quick_ask_parts::{box_rect, Outgoing, Over, BOX_SIZE};
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

fn flow() -> MutexGuard<'static, Flow> {
    FLOW.lock().unwrap_or_else(|p| p.into_inner())
}

/// Its shortcut: the box comes up over the app in front, which it remembers.
pub fn open(app: &AppHandle) {
    if !cfg!(windows) {
        log::info!("The quick-ask box opens on Windows only");
        return;
    }
    if askbox::game_in_front(app) {
        let why = "Ask Pip waits while a game or something fullscreen is in front.";
        toast::show(app, "Ask Pip", why, None);
        return;
    }
    let over = over_now(app);
    flow().opened(over);
    let app = app.clone();
    // Off the shortcut's thread: making a WebView2 window there can deadlock (window.rs).
    tauri::async_runtime::spawn_blocking(move || show(&app));
}

/// The window in front as the box remembers it; None when that is the box itself. Nook's own
/// windows get the focus back too, but are nothing to tell Pip.
fn over_now(app: &AppHandle) -> Option<Over> {
    let f = foreground::front()?;
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

/// The view as it is now, with Nook's theme.
fn view(app: &AppHandle, now: Instant) -> AskView {
    let mut v = flow().view(now);
    v.chrome = askbox::chrome(app);
    v
}

fn emit(app: &AppHandle) {
    let v = view(app, Instant::now());
    if let Err(e) = app.emit_to(LABEL, VIEW_EVENT, v) {
        log::debug!("Couldn't tell the quick-ask box: {e}");
    }
}

/// Clicking elsewhere puts the box away; whatever waits to be sent still goes.
pub fn blurred(window: &tauri::Window) {
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
        let Some(Outgoing { text, context }) = due else {
            return;
        };
        emit(&app);
        let Some(h) = super::link(&app) else {
            return failed(&app, id, "Pair the app with Nook in Settings to use Pip.");
        };
        crate::nook::pip(&app, PipMood::Thinking);
        let context = context.and_then(|c| serde_json::to_value(c).ok());
        match h.send_with(&text, None, context).await {
            Ok(sent) => {
                let took = flow().sent(id);
                if !took {
                    return crate::nook::pip(&app, PipMood::Idle);
                }
                emit(&app);
                if away(&app) {
                    let link = askbox::page_link(DockPage::Conversation);
                    toast::show(&app, SENT, &text, link.as_deref());
                }
                listen(&app, &h, id, sent).await;
            }
            // It may have gone all the same: the box doesn't send it again on its own.
            Err(e) if e == TIMED_OUT => failed(&app, id, MAYBE_SENT),
            Err(e) => failed(&app, id, &e),
        }
    });
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

/// The box's window, which Nook counts as one of its own (host.rs, own_windows).
#[cfg(windows)]
pub fn hwnd(app: &AppHandle) -> Option<isize> {
    let w = app.get_webview_window(LABEL)?;
    w.hwnd().ok().map(|h| h.0 as isize)
}

/// The work area, in physical px, and DPI of the monitor that window is on (the primary when
/// there is none).
#[cfg(windows)]
fn spot(at: Option<isize>) -> Option<((i32, i32, i32, i32), u32)> {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MonitorFromWindow, MONITORINFO,
        MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    let monitor = unsafe {
        match at {
            Some(h) => MonitorFromWindow(HWND(h as *mut _), MONITOR_DEFAULTTONEAREST),
            None => MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY),
        }
    };
    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
        return None;
    }
    let (mut dx, mut dy) = (96u32, 96u32);
    let _ = unsafe { GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    let r = info.rcWork;
    Some(((r.left, r.top, r.right, r.bottom), dx))
}

/// The focus back to the window the box opened over, if it is still that app's, and not
/// minimized. Nothing else about it changes.
#[cfg(windows)]
fn give_back(over: &Over) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow,
    };
    let h = HWND(over.hwnd as *mut _);
    let mut pid = 0u32;
    unsafe {
        if !IsWindow(Some(h)).as_bool() || IsIconic(h).as_bool() {
            return;
        }
        GetWindowThreadProcessId(h, Some(&mut pid));
        if pid == over.pid {
            let _ = SetForegroundWindow(h);
        }
    }
}

#[cfg(not(windows))]
pub fn hwnd(_app: &AppHandle) -> Option<isize> {
    None
}

#[cfg(not(windows))]
fn spot(_at: Option<isize>) -> Option<((i32, i32, i32, i32), u32)> {
    None
}

#[cfg(not(windows))]
fn give_back(_over: &Over) {}
