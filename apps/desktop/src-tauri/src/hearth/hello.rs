// Windows Hello for Hearth's window (D80). Connecting this PC makes the window a Windows Hello key
// (KeyCredentialManager: its private half never leaves this PC) and gives Hearth its public half.
// When the window is signed out, its sign-in page asks this app (hearth://sign-in, taken only
// from the window itself): Windows Hello signs Hearth's challenge once it has seen your face,
// finger or PIN, and the signature buys the window a one-time code, as connecting does. Windows
// asks every time, so a program that read this app's token still can't sign in without you.
//
// Windows Hello opens its own prompt; the app never sees your PIN or face. Nothing here runs in
// tests: they cover the server's side (apps/server/src/window-hello.test.ts) and the plumbing.

use super::client::http;
use super::{links, window, DESKTOP_KEY};
use crate::settings::get_settings;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::AppHandle;

/// The key's name in this Windows user's Windows Hello. Making it again replaces it.
#[cfg_attr(not(windows), allow(dead_code))]
const KEY_NAME: &str = "Nook window sign-in";

/// A sign-in is waiting on Windows Hello or Hearth; pressing the button again does nothing.
static SIGNING: AtomicBool = AtomicBool::new(false);

/// What Windows Hello said, when it wasn't yes.
#[derive(Debug, PartialEq, Eq)]
pub enum HelloError {
    /// No Windows Hello on this PC, or no PIN set up for it.
    Unsupported,
    /// This PC has no key for the window (made on another install, or removed).
    NoKey,
    /// You closed the prompt.
    Cancelled,
    /// Windows Hello is locked after too many tries.
    Locked,
    Failed(String),
}

impl HelloError {
    pub fn message(&self) -> String {
        match self {
            Self::Unsupported => "Windows Hello isn't set up on this PC".into(),
            Self::NoKey => "this PC has no Windows Hello key for Nook's window".into(),
            Self::Cancelled => "Windows Hello was closed".into(),
            Self::Locked => "Windows Hello is locked for now".into(),
            Self::Failed(why) => format!("Windows Hello didn't work ({why})"),
        }
    }
}

/// Why the window wasn't signed in, as its sign-in page reads it: `/?hello=<word>` (Login.tsx).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotIn {
    /// You closed Windows Hello: try again.
    Cancelled,
    /// The window has to be connected from your browser again.
    Connect,
    /// Something else went wrong: try again, or connect from your browser.
    Failed,
}

impl NotIn {
    pub fn word(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Connect => "connect",
            Self::Failed => "failed",
        }
    }

    fn from_hello(e: &HelloError) -> Self {
        match e {
            HelloError::Cancelled => Self::Cancelled,
            HelloError::NoKey => Self::Connect,
            _ => Self::Failed,
        }
    }

    /// Hearth's answer: the token or key it knew is gone (401), the token is from before this
    /// (403), or there's no key (409), and connecting again fixes each. Anything else may pass.
    fn from_status(status: u16) -> Self {
        match status {
            401 | 403 | 409 => Self::Connect,
            _ => Self::Failed,
        }
    }
}

/// Where the window goes after a sign-in: in with its code, or back to its sign-in page saying why.
pub fn after(result: &Result<String, NotIn>) -> String {
    match result {
        Ok(code) => format!("/api/auth/desktop/window?code={code}"),
        Err(why) => format!("/?hello={}", why.word()),
    }
}

/// Sends one of the window's Windows Hello requests, as this app: 0 when Hearth didn't answer.
async fn post(base: &str, token: &str, what: &str, body: Value) -> Result<Value, u16> {
    let res = http()
        .post(format!("{base}/api/auth/desktop/hello/{what}"))
        .bearer_auth(token)
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| {
            log::warn!("Windows Hello's {what} didn't reach Nook: {e}");
            0u16
        })?;
    let status = res.status().as_u16();
    if status != 200 {
        log::warn!("Nook refused Windows Hello's {what}: {status}");
        return Err(status);
    }
    res.json().await.map_err(|_| 0u16)
}

/// After connecting: Windows Hello makes the window's key (it asks you first), and Hearth takes
/// its public half with the ticket connecting gave.
pub async fn enroll(base: &str, token: &str, ticket: &str) -> Result<(), String> {
    let public = tauri::async_runtime::spawn_blocking(os::create)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.message())?;
    post(
        base,
        token,
        "enroll",
        json!({ "ticket": ticket, "publicKey": public }),
    )
    .await
    .map(|_| ())
    .map_err(|status| format!("Nook didn't take Windows Hello's key ({status})"))
}

/// hearth://sign-in from the window's sign-in page.
pub fn sign_in(app: &AppHandle) {
    if SIGNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = sign_in_now(&app).await;
        window::open(&app, &after(&result));
        SIGNING.store(false, Ordering::SeqCst);
    });
}

async fn sign_in_now(app: &AppHandle) -> Result<String, NotIn> {
    let token = get_settings(app)
        .hearth_keys
        .get(DESKTOP_KEY)
        .cloned()
        .unwrap_or_default();
    if token.trim().is_empty() {
        return Err(NotIn::Connect);
    }
    let base = window::home(app)
        .ok_or(NotIn::Failed)?
        .origin()
        .ascii_serialization();
    let asked = post(&base, &token, "challenge", json!({}))
        .await
        .map_err(NotIn::from_status)?;
    let challenge = asked["challenge"]
        .as_str()
        .filter(|c| links::is_code(c))
        .ok_or(NotIn::Failed)?
        .to_string();
    let to_sign = challenge.clone();
    let signature = tauri::async_runtime::spawn_blocking(move || os::sign(&to_sign))
        .await
        .map_err(|_| NotIn::Failed)?
        .map_err(|e| {
            log::warn!("Signing Nook's window in: {}", e.message());
            NotIn::from_hello(&e)
        })?;
    let answer = post(
        &base,
        &token,
        "verify",
        json!({ "challenge": challenge, "signature": signature }),
    )
    .await
    .map_err(NotIn::from_status)?;
    answer["code"]
        .as_str()
        .filter(|c| links::is_code(c))
        .map(str::to_string)
        .ok_or(NotIn::Failed)
}

#[cfg(windows)]
mod os {
    use super::{HelloError, KEY_NAME};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use windows::core::{w, HSTRING};
    use windows::Security::Credentials::{
        KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::Core::CryptographicPublicKeyBlobType;
    use windows::Security::Cryptography::CryptographicBuffer;
    use windows::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};

    fn failed(e: windows::core::Error) -> HelloError {
        HelloError::Failed(e.message().to_string())
    }

    fn status(s: KeyCredentialStatus) -> Result<(), HelloError> {
        match s {
            KeyCredentialStatus::Success => Ok(()),
            KeyCredentialStatus::NotFound => Err(HelloError::NoKey),
            KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => {
                Err(HelloError::Cancelled)
            }
            KeyCredentialStatus::SecurityDeviceLocked => Err(HelloError::Locked),
            other => Err(HelloError::Failed(format!("status {}", other.0))),
        }
    }

    fn supported() -> Result<(), HelloError> {
        match KeyCredentialManager::IsSupportedAsync().and_then(|op| op.get()) {
            Ok(true) => Ok(()),
            Ok(false) => Err(HelloError::Unsupported),
            Err(e) => Err(failed(e)),
        }
    }

    /// Makes the window's key, replacing any before it. Its public half, as SubjectPublicKeyInfo
    /// in base64.
    pub fn create() -> Result<String, HelloError> {
        supported()?;
        let op = KeyCredentialManager::RequestCreateAsync(
            &HSTRING::from(KEY_NAME),
            KeyCredentialCreationOption::ReplaceExisting,
        )
        .map_err(failed)?;
        let made = in_front(|| op.get()).map_err(failed)?;
        status(made.Status().map_err(failed)?)?;
        let public = made
            .Credential()
            .and_then(|c| {
                c.RetrievePublicKeyWithBlobType(
                    CryptographicPublicKeyBlobType::X509SubjectPublicKeyInfo,
                )
            })
            .map_err(failed)?;
        Ok(CryptographicBuffer::EncodeToBase64String(&public)
            .map_err(failed)?
            .to_string())
    }

    /// Windows Hello signs the challenge's characters with the window's key, once it has seen
    /// you. The signature, in base64.
    pub fn sign(challenge: &str) -> Result<String, HelloError> {
        supported()?;
        let opened = KeyCredentialManager::OpenAsync(&HSTRING::from(KEY_NAME))
            .and_then(|op| op.get())
            .map_err(failed)?;
        status(opened.Status().map_err(failed)?)?;
        let data =
            CryptographicBuffer::CreateFromByteArray(challenge.as_bytes()).map_err(failed)?;
        let op = opened
            .Credential()
            .and_then(|c| c.RequestSignAsync(&data))
            .map_err(failed)?;
        let signed = in_front(|| op.get()).map_err(failed)?;
        status(signed.Status().map_err(failed)?)?;
        let signature = signed.Result().map_err(failed)?;
        Ok(CryptographicBuffer::EncodeToBase64String(&signature)
            .map_err(failed)?
            .to_string())
    }

    /// Windows Hello's prompt can open behind the window that asked for it. While waiting on it,
    /// brings it in front once, if it shows within a few seconds; it's yours to answer.
    fn in_front<T>(wait: impl FnOnce() -> T) -> T {
        let done = Arc::new(AtomicBool::new(false));
        let watching = done.clone();
        std::thread::spawn(move || {
            for _ in 0..50 {
                if watching.load(Ordering::SeqCst) {
                    return;
                }
                if let Ok(prompt) = unsafe { FindWindowW(w!("Credential Dialog Xaml Host"), None) }
                {
                    if !prompt.is_invalid() {
                        let _ = unsafe { SetForegroundWindow(prompt) };
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
        let result = wait();
        done.store(true, Ordering::SeqCst);
        result
    }
}

#[cfg(not(windows))]
mod os {
    use super::HelloError;

    pub fn create() -> Result<String, HelloError> {
        Err(HelloError::Unsupported)
    }

    pub fn sign(_challenge: &str) -> Result<String, HelloError> {
        Err(HelloError::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::{after, HelloError, NotIn};

    #[test]
    fn the_window_goes_in_with_its_code_or_back_saying_why() {
        assert_eq!(
            after(&Ok("abcdefghijklmnopqrstuvwx".into())),
            "/api/auth/desktop/window?code=abcdefghijklmnopqrstuvwx"
        );
        assert_eq!(after(&Err(NotIn::Cancelled)), "/?hello=cancelled");
        assert_eq!(after(&Err(NotIn::Connect)), "/?hello=connect");
        assert_eq!(after(&Err(NotIn::Failed)), "/?hello=failed");
        // Both are pages the window may open.
        for path in [
            after(&Err(NotIn::Failed)),
            after(&Ok("abcdefghijklmnopqrstuvwx".into())),
        ] {
            assert!(super::links::relative_path(&path).is_ok(), "{path}");
        }
    }

    #[test]
    fn says_to_connect_again_only_when_that_would_help() {
        assert_eq!(NotIn::from_hello(&HelloError::Cancelled), NotIn::Cancelled);
        assert_eq!(NotIn::from_hello(&HelloError::NoKey), NotIn::Connect);
        assert_eq!(NotIn::from_hello(&HelloError::Locked), NotIn::Failed);
        assert_eq!(NotIn::from_hello(&HelloError::Unsupported), NotIn::Failed);
        for status in [401, 403, 409] {
            assert_eq!(NotIn::from_status(status), NotIn::Connect);
        }
        for status in [0, 400, 410, 500] {
            assert_eq!(NotIn::from_status(status), NotIn::Failed);
        }
    }
}
