// The real named objects, under a tag only this test uses, so the live session's Nook objects
// are never opened or signalled. No window is involved.

use crate::objects::session::{session_tag, Kind, SessionObjects};
use crate::objects::{object_name, Held, Signals};
use crate::recover::Reason;
use std::sync::Arc;
use std::time::Duration;

fn test_tag(name: &str) -> String {
    format!("test-{name}-{}", std::process::id())
}

#[test]
fn names_live_in_the_session_namespace() {
    assert_eq!(object_name("Revoked", "1"), "Local\\Nook.Revoked.1");
    assert!(session_tag().parse::<u32>().is_ok());
}

#[test]
fn revoke_fences_older_epochs_and_begin_clears_it() {
    let tag = test_tag("revoke");
    assert!(!SessionObjects::exists(&tag));
    let objects = SessionObjects::create(&tag).unwrap();
    assert!(SessionObjects::exists(&tag));
    assert!(!objects.is_revoked(5));

    objects.revoke(10);
    assert!(objects.is_revoked(10) && objects.is_revoked(20));
    assert_eq!(objects.epoch(), 10);

    // A second handle opened by name (as the guard or the CLI would) sees the same state.
    let other = SessionObjects::create(&tag).unwrap();
    assert!(other.is_revoked(10));
    other.begin(11);
    assert!(!objects.is_revoked(11));
    assert!(
        objects.is_revoked(10),
        "an older writer stays fenced by the epoch"
    );
}

#[test]
fn the_journal_mutex_excludes_other_threads() {
    let tag = test_tag("mutex");
    let objects = Arc::new(SessionObjects::create(&tag).unwrap());
    let held = Held::take(objects.as_ref(), Duration::ZERO).expect("free at first");
    let other = objects.clone();
    let blocked = std::thread::spawn(move || other.lock_journal(Duration::from_millis(50)));
    assert!(!blocked.join().unwrap());
    drop(held);
    let other = objects.clone();
    let free = std::thread::spawn(move || {
        let got = other.lock_journal(Duration::from_millis(50));
        if got {
            other.unlock_journal();
        }
        got
    });
    assert!(free.join().unwrap());
}

#[test]
fn a_request_carries_its_reason_and_finishing_answers_it() {
    let tag = test_tag("request");
    let app = SessionObjects::create(&tag).unwrap();
    let cli = SessionObjects::create(&tag).unwrap();
    app.arm();
    app.pulse();
    assert!(cli.is_armed());
    assert_eq!(cli.beats(), 1);

    cli.request_restore(Reason::Update);
    assert!(app.restore_requested());
    assert_eq!(app.requested_reason(), Reason::Update);
    assert!(!cli.wait_done(Duration::ZERO));
    app.finished();
    assert!(cli.wait_done(Duration::from_millis(50)));
    assert!(!app.restore_requested() && !cli.is_armed());
    assert!(!app.handle(Kind::Done).is_invalid());
}
