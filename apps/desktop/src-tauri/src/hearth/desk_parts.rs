// The desk's pieces that need neither Tauri nor Windows (desk.rs): its secret, the gate that holds
// it, and what Hearth's answers mean for the desk.
//
// The secret is what Windows Hello's signature bought at unlock (D84): with the app's token it
// opens the desk's actions, so it lives only in this process's memory. It is never written to
// disk or a log and never handed to a page; Debug prints none of it, and dropping it overwrites
// its bytes. The gate's fence is a count of locks: an unlock that started before Windows locked
// (Windows Hello may be up for a while) finds the count moved on when it finishes, and installs
// nothing, so a lock always wins over an unlock in flight, here as on Hearth's side.

use serde_json::Value;
use std::fmt;
use std::sync::Arc;

/// The desk's secret, as Hearth gave it at unlock.
pub struct Secret(Box<[u8]>);

impl Secret {
    /// Takes the secret out of Hearth's answer, when it looks like one: 16 to 128 URL-safe
    /// characters (links::is_code's rule). The answer keeps no copy of it.
    pub fn take(answer: &mut Value) -> Option<Secret> {
        let Value::String(s) = answer.get_mut("secret")?.take() else {
            return None;
        };
        let mut bytes = s.into_bytes();
        let fits = (16..=128).contains(&bytes.len())
            && bytes
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_');
        let secret = fits.then(|| Secret(bytes.clone().into_boxed_slice()));
        wipe(&mut bytes);
        secret
    }

    /// The x-hearth-desk header's value, marked sensitive so nothing that logs headers shows it.
    pub fn header(&self) -> Option<reqwest::header::HeaderValue> {
        let mut v = reqwest::header::HeaderValue::from_bytes(&self.0).ok()?;
        v.set_sensitive(true);
        Some(v)
    }
}

/// Overwrites bytes in a way the compiler won't leave out because they're about to be freed.
fn wipe(bytes: &mut [u8]) {
    for b in bytes.iter_mut() {
        // SAFETY: `b` is a valid, aligned, exclusive reference to a byte.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

impl Drop for Secret {
    fn drop(&mut self) {
        wipe(&mut self.0);
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(…)")
    }
}

/// Holds the secret while the desk is open here, and the count of locks.
#[derive(Debug, Default)]
pub struct Gate {
    secret: Option<Arc<Secret>>,
    fence: u64,
}

impl Gate {
    pub const fn new() -> Gate {
        Gate {
            secret: None,
            fence: 0,
        }
    }

    /// Where an unlock starts: the count it must still find when it finishes.
    pub fn begin(&self) -> u64 {
        self.fence
    }

    /// Opens the desk with the unlock's secret, unless it was locked since the unlock began.
    pub fn open(&mut self, began: u64, secret: Secret) -> bool {
        if began != self.fence {
            return false;
        }
        self.secret = Some(Arc::new(secret));
        true
    }

    /// The secret to send with a desk action, while the desk is open.
    pub fn key(&self) -> Option<Arc<Secret>> {
        self.secret.clone()
    }

    pub fn is_open(&self) -> bool {
        self.secret.is_some()
    }

    /// Windows locked, slept or the app is quitting: drops the secret and moves the count on.
    pub fn lock(&mut self) {
        self.fence += 1;
        self.secret = None;
    }

    /// Hearth said the desk is shut for `used`: drops it, unless a newer unlock replaced it.
    pub fn shut(&mut self, used: &Arc<Secret>) {
        if self.secret.as_ref().is_some_and(|s| Arc::ptr_eq(s, used)) {
            self.secret = None;
        }
    }
}

/// Why the desk couldn't do something, as the Inbox card says it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeskError {
    /// The desk is shut: never opened here, Windows locked, idle for two hours, or eight hours
    /// passed. Windows Hello opens it again.
    Shut,
    /// This PC isn't connected to Hearth, or Hearth no longer knows its token.
    Connect,
    /// Windows Hello isn't set up on this PC, or Hearth has no Windows Hello key for it.
    NoHello,
    /// You closed Windows Hello's prompt.
    HelloClosed,
    /// Windows Hello is locked after too many tries.
    HelloLocked,
    /// Hearth didn't answer.
    Offline,
    /// Hearth said no to this one, in its own words: a card that's gone, replies gone stale.
    Refused { code: String, message: String },
}

impl DeskError {
    /// One word for the page (inboxTypes.ts reads it).
    pub fn word(&self) -> &'static str {
        match self {
            Self::Shut => "shut",
            Self::Connect => "connect",
            Self::NoHello => "no_hello",
            Self::HelloClosed => "hello_closed",
            Self::HelloLocked => "hello_locked",
            Self::Offline => "offline",
            Self::Refused { .. } => "refused",
        }
    }

    /// What the card says, plainly.
    pub fn says(&self) -> String {
        match self {
            Self::Shut => "Unlock with Windows Hello to see what waits.".into(),
            Self::Connect => "This PC isn't connected to Hearth. Connect it in Settings.".into(),
            Self::NoHello => {
                "Windows Hello isn't set up for Nook on this PC, so the desk can't open here."
                    .into()
            }
            Self::HelloClosed => "Windows Hello was closed. Press Enter to try again.".into(),
            Self::HelloLocked => "Windows Hello is locked for now. Try again later.".into(),
            Self::Offline => "Hearth isn't answering right now.".into(),
            Self::Refused { message, .. } => message.clone(),
        }
    }
}

/// What a desk action's answer means: its result, or why not. `status` is 0 when Hearth didn't
/// answer at all. A 403 may mean the desk is shut or a refusal of its own; desk.rs asks Hearth
/// which before it drops the secret.
pub fn verdict(status: u16, body: &Value) -> Result<Value, DeskError> {
    if status == 0 {
        return Err(DeskError::Offline);
    }
    if status == 401 {
        return Err(DeskError::Connect);
    }
    if status == 200 && body["status"] == "ok" {
        return Ok(body["result"].clone());
    }
    let text = |k: &str| body[k].as_str().map(str::to_string);
    let message = text("message")
        .or_else(|| text("reason"))
        .or_else(|| text("error"))
        .unwrap_or_else(|| format!("Hearth said no ({status})."));
    let code = text("code").unwrap_or_else(|| status.to_string());
    Err(DeskError::Refused {
        code,
        message: clip(&message, 200),
    })
}

/// At most `max` characters, so a long refusal fits the card.
fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

/// What unlocking was told by Hearth, before Windows Hello is asked or after it signed: 403 is a
/// request that didn't come straight from this PC (Hearth reached through another address); 409
/// Hearth with no Windows Hello key for this PC; 410 an unlock that ran out or a lock meanwhile.
pub fn unlock_refusal(status: u16) -> DeskError {
    match status {
        0 => DeskError::Offline,
        401 => DeskError::Connect,
        403 => DeskError::Refused {
            code: "forbidden".into(),
            message: "The desk opens only while Nook reaches Hearth on this PC.".into(),
        },
        409 => DeskError::NoHello,
        410 => DeskError::Shut,
        s => DeskError::Refused {
            code: s.to_string(),
            message: "Hearth didn't open the desk. Try again.".into(),
        },
    }
}
