use super::*;
use crate::hearth::quick_ask_parts::{box_rect, MAX_TEXT};

fn chrome() -> Over {
    Over {
        hwnd: 0x100,
        pid: 4242,
        app: Some("Google Chrome".into()),
        title: Some("Pull request #191 · Nook".into()),
    }
}

fn slack() -> Over {
    Over {
        hwnd: 0x200,
        pid: 77,
        app: Some("Slack".into()),
        title: Some("#general".into()),
    }
}

fn opened() -> Flow {
    let mut flow = Flow::new();
    flow.opened(Some(chrome()));
    flow
}

fn line(over: &Over) -> String {
    Context::of(over).unwrap().line()
}

#[test]
fn where_it_was_asked_goes_apart_from_the_words_and_the_box_shows_it_whole() {
    let c = Context::of(&chrome()).unwrap();
    assert_eq!(c.line(), "From Google Chrome: \"Pull request #191 · Nook\"");
    assert_eq!(
        serde_json::to_value(&c).unwrap(),
        serde_json::json!({ "app": "Google Chrome", "title": "Pull request #191 · Nook" })
    );
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.send("Review this for me", now).unwrap().unwrap();
    let out = flow.due(id).unwrap();
    assert_eq!(
        out.text, "Review this for me",
        "the title is never in the words"
    );
    assert_eq!(out.context, Some(c));
    // Over Nook's own window there's nothing to say.
    let own = Over {
        app: None,
        title: None,
        ..chrome()
    };
    assert_eq!(Context::of(&own), None);
    // A title that is just the app's name goes as the name alone.
    let same = Over {
        title: Some("Slack".into()),
        ..slack()
    };
    let c = Context::of(&same).unwrap();
    assert_eq!(c.line(), "From Slack");
    assert_eq!(
        serde_json::to_value(&c).unwrap(),
        serde_json::json!({ "app": "Slack" })
    );
}

#[test]
fn a_title_stays_one_line_inside_its_quotes() {
    let odd = Over {
        title: Some("Inbox\r\n\"urgent\"\u{1b}[31m   now".into()),
        ..chrome()
    };
    assert_eq!(
        line(&odd),
        "From Google Chrome: \"Inbox 'urgent' [31m now\""
    );
    let long = Over {
        title: Some("x".repeat(500)),
        ..chrome()
    };
    let from = line(&long);
    assert!(from.ends_with("…\""), "{from}");
    assert_eq!(from.chars().count(), "From Google Chrome: \"\"".len() + 120);
}

#[test]
fn nothing_goes_until_the_wait_for_an_undo_is_over() {
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.send("  Remind me at 5  ", now).unwrap().unwrap();
    let v = flow.view(now);
    assert_eq!((v.phase, v.undo_ms), (AskPhase::Waiting, 2000));
    assert_eq!(flow.view(now + Duration::from_millis(1500)).undo_ms, 500);
    // A second Enter does nothing, and says nothing.
    assert_eq!(flow.send("again", now), Ok(None));
    assert_eq!(flow.view(now).seq, v.seq);
    // The wait is over: the message goes.
    assert_eq!(flow.due(id).unwrap().text, "Remind me at 5");
    assert_eq!(flow.view(now).phase, AskPhase::Sending);
    assert_eq!(flow.due(id), None, "only once");
    // An Undo just too late says so, until Pip's own words come back.
    assert!(!flow.undo());
    assert_eq!(flow.view(now).note.as_deref(), Some(TOO_LATE));
    assert!(flow.sent(id));
    let v = flow.view(now);
    assert_eq!(
        (v.phase, v.note.as_deref()),
        (AskPhase::Sent, Some(TOO_LATE))
    );
    assert!(flow.answered(id, "On it.\n\nI'll remind you at 5 pm."));
    assert_eq!(flow.view(now).note.as_deref(), Some("On it."));
}

#[test]
fn undo_puts_the_text_back_once_and_the_wait_comes_to_nothing() {
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.send("Draft a reply", now).unwrap().unwrap();
    assert!(flow.undo());
    let v = flow.view(now);
    assert_eq!(v.phase, AskPhase::Typing);
    assert_eq!(v.draft.as_deref(), Some("Draft a reply"));
    assert_eq!(flow.due(id), None, "undone: nothing is sent");
    assert!(!flow.undo(), "nothing waits");
    assert_eq!(flow.view(now).note, None);
    // Opened again, the box keeps what was typed in it since: the text isn't put back twice.
    flow.opened(None);
    assert_eq!(flow.view(now).draft, None);
    // A new send is a new wait; the old one's end can't send it early.
    let next = flow.send("Draft a short reply", now).unwrap().unwrap();
    assert_ne!(next, id);
    assert_eq!(flow.due(id), None);
    assert!(flow.due(next).is_some());
    assert!(flow.sent(next));
    assert_eq!(flow.view(now).note.as_deref(), Some(SENT));
}

#[test]
fn opened_again_mid_wait_it_shows_what_the_message_goes_with_and_the_x_drops_it() {
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.send("Summarize this", now).unwrap().unwrap();
    flow.opened(Some(slack()));
    assert_eq!(flow.view(now).from, Some(line(&chrome())));
    assert_eq!(
        flow.over(),
        Some(&slack()),
        "Esc goes back to where it last opened"
    );
    // Undone, the text comes back with the context it was to go with.
    assert!(flow.undo());
    assert_eq!(flow.view(now).from, Some(line(&chrome())));
    let id2 = flow.send("Summarize this", now).unwrap().unwrap();
    assert_ne!(id, id2);
    // The × drops it from the message on show, and from the next one too.
    flow.drop_context();
    assert_eq!(flow.view(now).from, None);
    assert_eq!(flow.due(id2).unwrap().context, None);
    flow.drop_context();
    assert_eq!(flow.view(now).from, None, "too late to change once it goes");
    flow.sent(id2);
    let next = flow.send("And this", now).unwrap().unwrap();
    assert_eq!(flow.due(next).unwrap().context, None);
    flow.sent(next);
    // Opened over an app again, the box has its context again.
    flow.opened(Some(slack()));
    assert_eq!(
        flow.view(now).from.as_deref(),
        Some("From Slack: \"#general\"")
    );
}

#[test]
fn a_send_that_fails_puts_the_text_back_saying_why() {
    let mut flow = opened();
    let now = Instant::now();
    let id = flow.send("Book the room", now).unwrap().unwrap();
    flow.due(id).unwrap();
    assert!(flow.failed(id, "Couldn't reach Nook. Is it running?"));
    let v = flow.view(now);
    assert_eq!(v.phase, AskPhase::Failed);
    assert_eq!(v.draft.as_deref(), Some("Book the room"));
    assert_eq!(v.from, Some(line(&chrome())));
    assert_eq!(
        v.note.as_deref(),
        Some("Couldn't reach Nook. Is it running?")
    );
    // Opened again it still says why, and Enter sends it again.
    flow.opened(Some(chrome()));
    assert_eq!(flow.view(now).phase, AskPhase::Failed);
    assert!(flow.send("Book the room", now).unwrap().is_some());
}

#[test]
fn an_empty_box_sends_nothing_and_an_answer_opens_empty() {
    let mut flow = opened();
    let now = Instant::now();
    assert!(flow.send(" \n\u{7} ", now).is_err());
    assert_eq!(flow.view(now).phase, AskPhase::Typing);
    let id = flow
        .send("x".repeat(MAX_TEXT + 50).as_str(), now)
        .unwrap()
        .unwrap();
    assert_eq!(flow.due(id).unwrap().text, "x".repeat(MAX_TEXT));
    flow.sent(id);
    // Opened over the box itself, it keeps the app it remembers; after an answer it is empty.
    flow.opened(None);
    assert_eq!(flow.over(), Some(&chrome()));
    assert_eq!(flow.view(now).phase, AskPhase::Typing);
    // A late answer to a message the box no longer shows changes nothing.
    assert!(!flow.answered(id, "Done."));
    assert!(!flow.showing(id));
}

#[test]
fn the_page_reads_its_commands_and_the_view_in_snake_case() {
    let read = |s: &str| serde_json::from_str::<AskCmd>(s).unwrap();
    assert_eq!(
        read(r#"{"kind":"send","text":"hi"}"#),
        AskCmd::Send { text: "hi".into() }
    );
    assert_eq!(
        read(r#"{"kind":"open_conversation"}"#),
        AskCmd::OpenConversation
    );
    assert_eq!(read(r#"{"kind":"drop_context"}"#), AskCmd::DropContext);
    assert!(serde_json::from_str::<AskCmd>(r#"{"kind":"open","path":"/api"}"#).is_err());
    let json = serde_json::to_value(opened().view(Instant::now())).unwrap();
    assert_eq!(json["phase"], "typing");
    assert_eq!(json["undo_ms"], 0);
    assert!(
        json.get("over").is_none(),
        "a window handle never reaches the page"
    );
}

#[test]
fn the_box_sits_centred_a_quarter_down_its_monitor_at_the_size_its_page_is_drawn() {
    let work = (0, 0, 2560, 1400);
    assert_eq!(box_rect(work, 96), (1000, 313, 560, 148));
    // At 150 % (DPI times text size) it is half as big again.
    assert_eq!(box_rect(work, 144), (860, 294, 840, 222));
    // A second monitor to the left, and one too small for it.
    assert_eq!(box_rect((-1920, 0, 0, 1040), 96).0, -1920 + 680);
    assert_eq!(box_rect((0, 0, 400, 100), 96), (0, 0, 400, 100));
}
