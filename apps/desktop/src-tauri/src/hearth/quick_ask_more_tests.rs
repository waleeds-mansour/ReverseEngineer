// The quick-ask box's mic and its follow-ups (quick_ask_flow.rs); quick_ask_tests.rs has the rest.
use super::*;
use crate::hearth::quick_ask_parts::{conversation_gone, FOLLOW_UP};

fn opened() -> Flow {
    let mut flow = Flow::new();
    flow.opened(Some(Over {
        hwnd: 0x100,
        pid: 4242,
        app: Some("Google Chrome".into()),
        title: Some("Pull request #191 · Nook".into()),
    }));
    flow
}

/// Sends `text` at `now` and has Nook take it into `conversation`; what went.
fn ask(flow: &mut Flow, text: &str, now: Instant, conversation: &str) -> Outgoing {
    let id = flow.send(text, now).unwrap().unwrap();
    let out = flow.due(id).unwrap();
    assert!(flow.sent(id, conversation, now));
    out
}

#[test]
fn a_follow_up_within_ten_minutes_continues_the_last_ask_and_says_so() {
    let mut flow = opened();
    let t0 = Instant::now();
    assert_eq!(flow.view(t0).continuing, None, "the first ask starts one");
    let first = ask(&mut flow, "Find a time with\nSam next week", t0, "c1");
    assert_eq!(first.conversation, None);
    // Sent, the box says where the next ask goes, with the conversation's title.
    let soon = t0 + Duration::from_secs(60);
    assert_eq!(
        flow.view(soon).continuing.as_deref(),
        Some("Find a time with Sam next week")
    );
    flow.opened(None);
    let id = flow.send("Make it Thursday", soon).unwrap().unwrap();
    assert_eq!(
        flow.view(soon).continuing.as_deref(),
        Some("Find a time with Sam next week"),
        "while it waits, where it goes"
    );
    assert_eq!(flow.due(id).unwrap().conversation.as_deref(), Some("c1"));
    assert!(flow.sent(id, "c1", soon));
    // The title stays the first ask's, and the ten minutes run from the last ask.
    let later = soon + FOLLOW_UP - Duration::from_secs(1);
    assert_eq!(
        flow.view(later).continuing.as_deref(),
        Some("Find a time with Sam next week")
    );
    assert_eq!(flow.view(soon + FOLLOW_UP).continuing, None);
    let late = ask(&mut flow, "Something else", soon + FOLLOW_UP, "c2");
    assert_eq!(late.conversation, None, "too long after: a new one");
}

#[test]
fn tab_starts_a_new_conversation_instead_and_tab_again_continues() {
    let mut flow = opened();
    let now = Instant::now();
    flow.toggle_fresh(now);
    assert!(
        !flow.view(now).fresh,
        "nothing to continue, nothing to choose"
    );
    ask(&mut flow, "Plan the offsite", now, "c1");
    flow.opened(None);
    flow.toggle_fresh(now);
    let v = flow.view(now);
    assert_eq!((v.continuing, v.fresh), (None, true));
    flow.toggle_fresh(now);
    assert_eq!(
        flow.view(now).continuing.as_deref(),
        Some("Plan the offsite")
    );
    flow.toggle_fresh(now);
    // Tab's choice holds through an Undo, and goes with the ask.
    let id = flow
        .send("Unrelated: book a dentist", now)
        .unwrap()
        .unwrap();
    assert!(flow.undo());
    assert!(flow.view(now).fresh);
    let id2 = flow
        .send("Unrelated: book a dentist", now)
        .unwrap()
        .unwrap();
    assert_ne!(id, id2);
    assert_eq!(flow.due(id2).unwrap().conversation, None);
    assert!(flow.sent(id2, "c2", now));
    // Now that one is the one to continue, and Tab's choice is spent.
    let v = flow.view(now);
    assert_eq!(v.continuing.as_deref(), Some("Unrelated: book a dentist"));
    assert!(!v.fresh);
    // Put away and opened again, the box keeps a choice not used yet, while it means something.
    flow.toggle_fresh(now);
    flow.opened(None);
    assert!(flow.view(now).fresh);
    let soon = now + Duration::from_secs(60);
    let id3 = flow.send("Book a dentist", soon).unwrap().unwrap();
    assert_eq!(flow.due(id3).unwrap().conversation, None);
}

#[test]
fn a_conversation_that_is_gone_gives_way_to_a_new_one_with_its_own_title() {
    let mut flow = opened();
    let now = Instant::now();
    ask(&mut flow, "Draft the invite", now, "c1");
    let id = flow.send("Add a dress code", now).unwrap().unwrap();
    assert_eq!(flow.due(id).unwrap().conversation.as_deref(), Some("c1"));
    // Nook put it in a new conversation: the box says so, and that is the one to continue now.
    assert!(flow.sent(id, "c9", now));
    assert_eq!(flow.view(now).note.as_deref(), Some(SENT_NEW));
    assert_eq!(
        flow.view(now).continuing.as_deref(),
        Some("Add a dress code")
    );
    assert!(flow.answered(id, "Done, black tie."));
    assert_eq!(flow.view(now).note.as_deref(), Some("Done, black tie."));
    assert_eq!(
        ask(&mut flow, "Thanks", now, "c9").conversation.as_deref(),
        Some("c9")
    );
}

#[test]
fn only_nook_saying_the_conversation_is_gone_sends_it_into_a_new_one() {
    assert!(conversation_gone(
        "Nook refused chat.send: Conversation not found"
    ));
    for other in [
        "Nook refused chat.send: Nook's database isn't reachable right now.",
        "Nook took too long to answer. Try again in a moment.",
        "Nook refused chat.send: This is a Slack member's conversation with the Jarvis bot.",
    ] {
        assert!(!conversation_gone(other), "{other}");
    }
}

#[test]
fn the_mic_listens_then_types_what_it_heard_into_the_box_once() {
    let mut flow = opened();
    let now = Instant::now();
    assert_eq!(flow.view(now).mic, AskMic::Ready);
    let id = flow.listen(false).unwrap();
    assert_eq!(flow.view(now).mic, AskMic::Listening);
    assert_eq!(flow.listen(false), None, "already listening");
    assert_eq!(flow.listening(), Some((id, false)));
    // Space or a second click: written down next.
    assert!(flow.stopped(id, true));
    assert_eq!(flow.view(now).mic, AskMic::Hearing);
    assert!(!flow.stopped(id, true), "only once");
    assert!(flow.heard(id, "  remind me to call Sam at five\r\n"));
    let v = flow.view(now);
    assert_eq!(v.mic, AskMic::Ready);
    assert_eq!(v.heard.as_deref(), Some("remind me to call Sam at five"));
    assert_eq!(v.phase, AskPhase::Typing, "never sent by itself");
    // Told once: the next change doesn't type it again.
    flow.drop_context();
    assert_eq!(flow.view(now).heard, None);
    assert!(!flow.heard(id, "again"));
}

#[test]
fn nothing_heard_or_a_failure_says_why_and_esc_throws_it_away() {
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.listen(false).unwrap();
    flow.stopped(id, true);
    flow.heard(id, "   ");
    let v = flow.view(now);
    assert_eq!((v.heard, v.note.as_deref()), (None, Some(HEARD_NOTHING)));
    // A mic that couldn't start says why, until the next listening.
    let id = flow.listen(false).unwrap();
    assert_eq!(flow.view(now).note, None);
    assert!(flow.talk_failed(id, "The microphone is busy with another recording."));
    assert_eq!(flow.view(now).mic, AskMic::Ready);
    assert!(flow.view(now).note.is_some());
    // Esc while listening: nothing is written down.
    let id = flow.listen(false).unwrap();
    assert!(flow.stopped(id, false));
    assert_eq!(flow.view(now).mic, AskMic::Ready);
    assert!(!flow.heard(id, "too late"));
    assert_eq!(flow.view(now).heard, None);
}

/// Listening `id` stopped without keeping it, as the box's Esc or another key during a Ctrl hold
/// does: the mic is ready while the recorder still lets go, and the page is told again after.
fn esc_then_let_go(flow: &mut Flow, id: u64, now: Instant) {
    assert!(flow.stopped(id, false));
    let v = flow.view(now);
    assert_eq!(v.mic, AskMic::Ready);
    assert!(!flow.mic_busy(true), "still the box's own recording");
    assert!(flow.released(id));
    let after = flow.view(now);
    assert!(after.seq > v.seq, "a new view, which the page draws");
    assert_eq!(after.mic, AskMic::Ready);
    assert!(!flow.mic_busy(false));
    assert!(!flow.released(id), "once");
}

#[test]
fn esc_while_listening_leaves_the_mic_ready_once_the_recorder_lets_go() {
    let mut flow = opened();
    let now = Instant::now();
    // The mic clicked, then Esc.
    let id = flow.listen(false).unwrap();
    assert!(!flow.mic_busy(true), "listening");
    esc_then_let_go(&mut flow, id, now);
    // Held by Ctrl, then another key.
    let id = flow.listen(true).unwrap();
    esc_then_let_go(&mut flow, id, now);
    // Dictation has the microphone now: busy.
    assert!(flow.mic_busy(true));
    // A mic that couldn't start holds nothing.
    let id = flow.listen(false).unwrap();
    assert!(flow.talk_failed(id, "The microphone is busy with another recording."));
    assert!(flow.mic_busy(true));
    assert!(!flow.released(id));
}

#[test]
fn esc_while_it_is_written_down_throws_away_what_was_said() {
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.listen(false).unwrap();
    assert!(
        !flow.forget_hearing(),
        "listening is stopped, not forgotten"
    );
    assert!(flow.stopped(id, true));
    assert!(flow.released(id));
    assert!(flow.forget_hearing());
    assert_eq!(flow.view(now).mic, AskMic::Ready);
    assert!(!flow.heard(id, "words after the Esc"));
    assert_eq!(flow.view(now).heard, None);
    assert!(!flow.forget_hearing());
}

#[test]
fn held_by_ctrl_it_says_so_and_the_mic_waits_while_a_message_does() {
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.listen(true).unwrap();
    assert_eq!(flow.view(now).mic, AskMic::Held);
    assert_eq!(flow.listening(), Some((id, true)));
    flow.stopped(id, true);
    flow.heard(id, "What's on tomorrow?");
    // While a message waits or goes, the mic doesn't listen.
    let sid = flow.send("What's on tomorrow?", now).unwrap().unwrap();
    assert_eq!(flow.listen(false), None);
    flow.due(sid);
    assert_eq!(flow.listen(false), None);
    flow.sent(sid, "c1", now);
    // After the answer it does, and the box is ready for the next ask.
    assert!(flow.listen(false).is_some());
    assert_eq!(flow.view(now).phase, AskPhase::Typing);
}

#[test]
fn the_page_reads_the_new_commands_and_view_in_snake_case() {
    let read = |s: &str| serde_json::from_str::<AskCmd>(s).unwrap();
    assert_eq!(read(r#"{"kind":"listen"}"#), AskCmd::Listen);
    assert_eq!(
        read(r#"{"kind":"stop_listening","keep":true}"#),
        AskCmd::StopListening { keep: true }
    );
    assert_eq!(read(r#"{"kind":"fresh"}"#), AskCmd::Fresh);
    let json = serde_json::to_value(opened().view(Instant::now())).unwrap();
    assert_eq!(json["mic"], "ready");
    assert_eq!(json["fresh"], false);
    assert!(json["continuing"].is_null());
}
