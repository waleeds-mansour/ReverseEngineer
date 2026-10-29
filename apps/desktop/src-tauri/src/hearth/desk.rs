// The desk (D84) from the desktop's side: what lets the dock's Inbox answer Pip from the keyboard.
// Windows Hello opens it once per sitting. Hearth gives a challenge, Windows Hello signs it with
// this PC's key once it has seen your face, finger or PIN (hello.rs's KeyCredential path, the
// same key that signs Hearth's window in, D80), and Hearth answers the signature with the desk's
// secret. From then on each desk action (desk.list, desk.decide, desk.mark, desk.answer,
// desk.reply) goes with the app's token and that secret in the x-hearth-desk header, and only
// answers while Hearth also has the desk open: at most 8 hours, 2 of them idle.
//
// The secret is held in memory only (desk_parts.rs's Secret: never on disk, in a log or on a
// page, wiped when dropped). It is dropped the moment Windows locks, the session disconnects or
// the PC goes to sleep (desk_watch.rs), and when the app quits; each time Hearth is told too, so
// its side shuts as well. When Hearth answers a desk action with 403 the app asks Hearth whether
// the desk is still open for this secret, and drops it only when it isn't: a refusal of the
// action's own (a Slack member's thread, say) leaves the desk open. Windows Hello's prompt can't
// run in tests, so signing is passed in: desk_tests.rs signs with a fake and covers the rest
// against a small stand-in for Hearth.

use super::client::http;
use super::hello::HelloError;
use super::{links, window, DESKTOP_KEY};
use crate::settings::get_settings;
use reqwest::Method;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tauri::AppHandle;

#[path = "desk_parts.rs"]
mod parts;
#[path = "desk_watch.rs"]
mod watch;

#[cfg(test)]
#[path = "desk_tests.rs"]
mod tests;

pub use parts::DeskError;
use parts::{unlock_refusal, verdict, Gate, Secret};

/// The header the desk's secret goes in (apps/server/src/auth/desk.ts).
pub const DESK_HEADER: &str = "x-hearth-desk";
/// How long one of the desk's requests may take.
const WAIT: Duration = Duration::from_secs(10);
/// How long quitting waits for Hearth to hear the desk is shut.
const QUIT_WAIT: Duration = Duration::from_millis(1500);

/// The desk here: its secret while it is open.
static GATE: Mutex<Gate> = Mutex::new(Gate::new());

/// Where Hearth is, and this PC's token for it.
pub struct Reach {
    base: String,
    token: String,
}

impl Reach {
    /// Hearth's address on this PC and the app's token, from the app's settings.
    pub fn of(app: &AppHandle) -> Result<Reach, DeskError> {
        let token = get_settings(app)
            .hearth_keys
            .get(DESKTOP_KEY)
            .cloned()
            .unwrap_or_default();
        if token.trim().is_empty() {
            return Err(DeskError::Connect);
        }
        let base = window::home(app)
            .ok_or(DeskError::Connect)?
            .origin()
            .ascii_serialization();
        Ok(Reach { base, token })
    }
}

fn gate(g: &Mutex<Gate>) -> MutexGuard<'_, Gate> {
    g.lock().unwrap_or_else(|e| e.into_inner())
}

/// One request to Hearth with the app's token, and the desk's secret when given: its status (0
/// when Hearth didn't answer) and its JSON body (null when it had none).
async fn send(
    reach: &Reach,
    method: Method,
    path: &str,
    body: Option<Value>,
    secret: Option<&Secret>,
) -> (u16, Value) {
    let mut req = http()
        .request(method, format!("{}{path}", reach.base))
        .bearer_auth(&reach.token)
        .timeout(WAIT);
    if let Some(v) = secret.and_then(Secret::header) {
        req = req.header(DESK_HEADER, v);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    match req.send().await {
        Ok(res) => {
            let status = res.status().as_u16();
            (status, res.json().await.unwrap_or(Value::Null))
        }
        Err(e) => {
            // The path only: never a header.
            log::warn!("The desk's {path} didn't reach Hearth: {e}");
            (0, Value::Null)
        }
    }
}

/// Windows Hello's no, as the card says it.
fn from_hello(e: HelloError) -> DeskError {
    match e {
        HelloError::Unsupported | HelloError::NoKey => DeskError::NoHello,
        HelloError::Cancelled => DeskError::HelloClosed,
        HelloError::Locked => DeskError::HelloLocked,
        HelloError::Failed(_) => DeskError::Refused {
            code: "hello".into(),
            message: e.message(),
        },
    }
}

/// Opens the desk in `g`: Hearth's challenge, signed by `sign` (Windows Hello, whose prompt
/// waits as long as you take), for the desk's secret. Locked meanwhile, it stays shut.
async fn unlock_at<S>(g: &Mutex<Gate>, reach: &Reach, sign: S) -> Result<(), DeskError>
where
    S: FnOnce(String) -> Result<String, HelloError> + Send + 'static,
{
    let began = gate(g).begin();
    let path = "/api/desktop/desk/challenge";
    let (status, asked) = send(reach, Method::POST, path, Some(json!({})), None).await;
    if status != 200 {
        return Err(unlock_refusal(status));
    }
    let challenge = asked["challenge"]
        .as_str()
        .filter(|c| links::is_code(c))
        .ok_or_else(|| unlock_refusal(502))?
        .to_string();
    let to_sign = challenge.clone();
    let signature = tauri::async_runtime::spawn_blocking(move || sign(to_sign))
        .await
        .map_err(|_| unlock_refusal(500))?
        .map_err(from_hello)?;
    let body = json!({ "challenge": challenge, "signature": signature });
    let path = "/api/desktop/desk/unlock";
    let (status, mut opened) = send(reach, Method::POST, path, Some(body), None).await;
    if status != 200 {
        return Err(unlock_refusal(status));
    }
    let secret = Secret::take(&mut opened).ok_or_else(|| unlock_refusal(502))?;
    if gate(g).open(began, secret) {
        Ok(())
    } else {
        Err(DeskError::Shut)
    }
}

/// One of the desk's actions through `g`: its result, or why not.
async fn act_at(
    g: &Mutex<Gate>,
    reach: &Reach,
    name: &str,
    input: Value,
) -> Result<Value, DeskError> {
    let key = gate(g).key().ok_or(DeskError::Shut)?;
    let path = format!("/api/actions/{name}");
    let (status, body) = send(reach, Method::POST, &path, Some(input), Some(&key)).await;
    if status == 401 || (status == 403 && !still_open(reach, &key).await) {
        gate(g).shut(&key);
        return Err(if status == 401 {
            DeskError::Connect
        } else {
            DeskError::Shut
        });
    }
    verdict(status, &body)
}

/// Whether Hearth still has the desk open for this secret.
async fn still_open(reach: &Reach, key: &Arc<Secret>) -> bool {
    let (status, body) = send(reach, Method::GET, "/api/desktop/desk", None, Some(key)).await;
    status == 200 && body["open"] == true
}

/// Tells Hearth the desk is shut. Shutting only takes power away, so it goes without the secret.
async fn tell_locked(reach: &Reach) {
    let path = "/api/desktop/desk/lock";
    let _ = send(reach, Method::POST, path, Some(json!({})), None).await;
}

/// Whether the desk is open here: a secret is held.
pub fn is_open() -> bool {
    gate(&GATE).is_open()
}

/// Opens the desk with Windows Hello. Windows locking or sleeping from now on shuts it.
pub async fn unlock(app: &AppHandle) -> Result<(), DeskError> {
    let reach = Reach::of(app)?;
    watch::start(app);
    unlock_at(&GATE, &reach, |c| super::hello::os::sign(&c)).await
}

/// One of the desk's actions: desk.list, desk.decide, desk.mark, desk.answer or desk.reply.
pub async fn act(app: &AppHandle, name: &str, input: Value) -> Result<Value, DeskError> {
    let reach = Reach::of(app)?;
    act_at(&GATE, &reach, name, input).await
}

/// Shuts the desk here at once, then tells Hearth in the background.
pub fn lock(app: &AppHandle) {
    gate(&GATE).lock();
    if let Ok(reach) = Reach::of(app) {
        tauri::async_runtime::spawn(async move { tell_locked(&reach).await });
    }
}

/// The app is quitting: shuts the desk, and gives Hearth up to QUIT_WAIT to hear it.
pub fn quit(app: &AppHandle) {
    let was_open = {
        let mut g = gate(&GATE);
        let open = g.is_open();
        g.lock();
        open
    };
    if !was_open {
        return;
    }
    let Ok(reach) = Reach::of(app) else {
        return;
    };
    // Its own thread, so this waits the same from inside the runtime or out of it.
    let (done, wait) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        tauri::async_runtime::block_on(tell_locked(&reach));
        let _ = done.send(());
    });
    let _ = wait.recv_timeout(QUIT_WAIT);
}
