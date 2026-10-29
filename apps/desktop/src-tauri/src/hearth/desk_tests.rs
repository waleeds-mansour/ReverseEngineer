// The desk's client (desk.rs) against a small stand-in for Hearth on a local port: unlocking with
// a fake Windows Hello, the secret going only where it should, a lock beating an unlock in flight,
// and 401/403 shutting the desk. Windows Hello's own prompt never runs here.

use super::parts::{unlock_refusal, verdict, Gate, Secret};
use super::{act_at, gate, unlock_at, DeskError, Reach, DESK_HEADER};
use crate::hearth::hello::HelloError;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const SECRET: &str = "s3cret-desk-value_0123456789abcdef";
const CHALLENGE: &str = "challenge-0123456789abcdef";

/// One answer the stand-in gives, in order: status and JSON body.
type Answer = (u16, Value);

/// A stand-in for Hearth that answers each request with the next of `answers` and keeps what it
/// was sent, one request per connection.
async fn hearth(answers: Vec<Answer>) -> (Reach, Arc<Mutex<Vec<String>>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let kept = seen.clone();
    tokio::spawn(async move {
        for (status, body) in answers {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = read_request(&mut stream).await;
            kept.lock().unwrap().push(request);
            let body = body.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    let token = "app-token".to_string();
    (Reach { base, token }, seen)
}

/// A whole request: its head and as much body as it says it has.
async fn read_request(stream: &mut tokio::net::TcpStream) -> String {
    let mut got = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = stream.read(&mut buf).await.unwrap();
        got.extend_from_slice(&buf[..n]);
        let text = String::from_utf8_lossy(&got).to_string();
        if let Some(end) = text.find("\r\n\r\n") {
            let wants = text[..end]
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                })
                .unwrap_or(0);
            if got.len() >= end + 4 + wants || n == 0 {
                return text;
            }
        }
        if n == 0 {
            return String::from_utf8_lossy(&got).to_string();
        }
    }
}

fn first_line(request: &str) -> &str {
    request.lines().next().unwrap_or("")
}

fn has_secret(request: &str) -> bool {
    request
        .to_ascii_lowercase()
        .contains(&format!("{DESK_HEADER}: {SECRET}").to_ascii_lowercase())
}

fn opened() -> Answer {
    (
        200,
        json!({ "secret": SECRET, "until": "x", "idleUntil": "y" }),
    )
}

fn challenge() -> Answer {
    (200, json!({ "challenge": CHALLENGE }))
}

fn signs(c: String) -> Result<String, HelloError> {
    Ok(format!("signed:{c}"))
}

#[tokio::test]
async fn unlocks_with_windows_hello_and_sends_the_secret_only_with_desk_actions() {
    static G: Mutex<Gate> = Mutex::new(Gate::new());
    let list = (200, json!({ "status": "ok", "result": { "cards": [] } }));
    let (reach, seen) = hearth(vec![challenge(), opened(), list]).await;
    unlock_at(&G, &reach, signs).await.unwrap();
    assert!(gate(&G).is_open());
    let result = act_at(&G, &reach, "desk.list", json!({})).await.unwrap();
    assert_eq!(result, json!({ "cards": [] }));
    let seen = seen.lock().unwrap();
    assert!(first_line(&seen[0]).starts_with("POST /api/desktop/desk/challenge "));
    assert!(first_line(&seen[1]).starts_with("POST /api/desktop/desk/unlock "));
    assert!(seen[1].contains(&format!("\"signature\":\"signed:{CHALLENGE}\"")));
    assert!(first_line(&seen[2]).starts_with("POST /api/actions/desk.list "));
    // The token always; the secret only once it exists, and only to the desk's actions.
    assert!(seen
        .iter()
        .all(|r| r.contains("authorization: Bearer app-token")));
    assert_eq!(
        seen.iter().map(|r| has_secret(r)).collect::<Vec<_>>(),
        [false, false, true]
    );
}

#[tokio::test]
async fn a_lock_while_windows_hello_is_up_wins() {
    static G: Mutex<Gate> = Mutex::new(Gate::new());
    let (reach, _) = hearth(vec![challenge(), opened()]).await;
    let locks_meanwhile = |c: String| {
        gate(&G).lock();
        signs(c)
    };
    assert_eq!(
        unlock_at(&G, &reach, locks_meanwhile).await,
        Err(DeskError::Shut)
    );
    assert!(!gate(&G).is_open());
}

#[tokio::test]
async fn says_why_the_desk_did_not_open() {
    static G: Mutex<Gate> = Mutex::new(Gate::new());
    // Hearth has no Windows Hello key for this PC: Windows Hello is never asked.
    let (reach, seen) = hearth(vec![(409, json!({ "error": "no key" }))]).await;
    let never = |_c: String| -> Result<String, HelloError> { panic!("asked Windows Hello") };
    assert_eq!(unlock_at(&G, &reach, never).await, Err(DeskError::NoHello));
    assert_eq!(seen.lock().unwrap().len(), 1);
    // You closed the prompt: nothing is sent to unlock.
    let (reach, seen) = hearth(vec![challenge()]).await;
    let closed = |_c: String| Err(HelloError::Cancelled);
    assert_eq!(
        unlock_at(&G, &reach, closed).await,
        Err(DeskError::HelloClosed)
    );
    assert_eq!(seen.lock().unwrap().len(), 1);
    // A signature Hearth doesn't take, or an answer with no proper secret.
    let (reach, _) = hearth(vec![challenge(), (401, json!({}))]).await;
    assert_eq!(unlock_at(&G, &reach, signs).await, Err(DeskError::Connect));
    let (reach, _) = hearth(vec![challenge(), (200, json!({ "secret": "short" }))]).await;
    assert!(matches!(
        unlock_at(&G, &reach, signs).await,
        Err(DeskError::Refused { .. })
    ));
    assert!(!gate(&G).is_open());
}

#[tokio::test]
async fn a_shut_desk_drops_the_secret_but_a_refusal_of_its_own_does_not() {
    static G: Mutex<Gate> = Mutex::new(Gate::new());
    let refused = (
        403,
        json!({ "status": "error", "code": "forbidden", "message": "Not here." }),
    );
    let (reach, seen) = hearth(vec![
        challenge(),
        opened(),
        refused.clone(),
        (200, json!({ "open": true })),
        refused,
        (200, json!({ "open": false })),
    ])
    .await;
    unlock_at(&G, &reach, signs).await.unwrap();
    let own = act_at(&G, &reach, "desk.reply", json!({ "id": "x", "choice": 0 })).await;
    assert_eq!(
        own,
        Err(DeskError::Refused {
            code: "forbidden".into(),
            message: "Not here.".into()
        })
    );
    assert!(gate(&G).is_open());
    let shut = act_at(&G, &reach, "desk.list", json!({})).await;
    assert_eq!(shut, Err(DeskError::Shut));
    assert!(!gate(&G).is_open());
    // Shut here, nothing more is sent until Windows Hello opens it again.
    assert_eq!(
        act_at(&G, &reach, "desk.list", json!({})).await,
        Err(DeskError::Shut)
    );
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 6);
    assert!(first_line(&seen[3]).starts_with("GET /api/desktop/desk "));
}

#[tokio::test]
async fn hearth_forgetting_this_pc_shuts_the_desk_and_says_to_connect() {
    static G: Mutex<Gate> = Mutex::new(Gate::new());
    let (reach, _) = hearth(vec![challenge(), opened(), (401, json!({}))]).await;
    unlock_at(&G, &reach, signs).await.unwrap();
    assert_eq!(
        act_at(&G, &reach, "desk.list", json!({})).await,
        Err(DeskError::Connect)
    );
    assert!(!gate(&G).is_open());
}

#[test]
fn the_secret_reads_as_nothing_and_leaves_no_copy_in_the_answer() {
    let mut answer = json!({ "secret": SECRET });
    let secret = Secret::take(&mut answer).unwrap();
    assert_eq!(answer["secret"], Value::Null);
    assert_eq!(format!("{secret:?}"), "Secret(…)");
    let header = secret.header().unwrap();
    assert!(header.is_sensitive());
    assert_eq!(header.as_bytes(), SECRET.as_bytes());
    for bad in [
        json!({ "secret": "short" }),
        json!({ "secret": "has space in it, sorry!" }),
        json!({ "secret": 5 }),
        json!({}),
    ] {
        assert!(Secret::take(&mut bad.clone()).is_none(), "{bad}");
    }
}

#[test]
fn the_fence_keeps_an_old_unlock_or_an_old_refusal_from_touching_a_newer_desk() {
    let mut g = Gate::new();
    let began = g.begin();
    g.lock();
    assert!(!g.open(
        began,
        Secret::take(&mut json!({ "secret": SECRET })).unwrap()
    ));
    assert!(g.open(
        g.begin(),
        Secret::take(&mut json!({ "secret": SECRET })).unwrap()
    ));
    let old = g.key().unwrap();
    assert!(g.open(
        g.begin(),
        Secret::take(&mut json!({ "secret": SECRET })).unwrap()
    ));
    // A 403 for the secret an earlier unlock gave leaves the newer one.
    g.shut(&old);
    assert!(g.is_open());
    let now = g.key().unwrap();
    g.shut(&now);
    assert!(!g.is_open());
}

#[test]
fn hearths_answers_read_as_the_card_says_them() {
    let ok = json!({ "status": "ok", "result": { "sent": true } });
    assert_eq!(verdict(200, &ok), Ok(json!({ "sent": true })));
    assert_eq!(verdict(0, &Value::Null), Err(DeskError::Offline));
    assert_eq!(verdict(401, &Value::Null), Err(DeskError::Connect));
    let stale = json!({ "status": "error", "code": "conflict", "message": "Those replies aren't offered any more." });
    assert_eq!(
        verdict(409, &stale),
        Err(DeskError::Refused {
            code: "conflict".into(),
            message: "Those replies aren't offered any more.".into()
        })
    );
    let long = json!({ "message": "x".repeat(500) });
    let Err(DeskError::Refused { message, .. }) = verdict(400, &long) else {
        panic!("not refused");
    };
    assert_eq!(message.chars().count(), 201);
    assert_eq!(unlock_refusal(409), DeskError::NoHello);
    assert_eq!(unlock_refusal(410), DeskError::Shut);
    assert!(matches!(unlock_refusal(403), DeskError::Refused { .. }));
    for e in [
        DeskError::Shut,
        DeskError::NoHello,
        DeskError::HelloClosed,
        DeskError::Offline,
    ] {
        assert!(!e.says().is_empty() && !e.word().is_empty());
    }
}
