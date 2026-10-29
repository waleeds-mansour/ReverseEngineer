// The Inbox's side of Nook without a window: which desk action each of the page's acts asks for,
// and where a refusal leaves it.

use super::*;

#[test]
fn each_answer_asks_the_desk_for_one_action_and_the_inboxs_own_acts_for_none() {
    let decide = InboxAct::Decide {
        approval_id: "a1".into(),
        yes: false,
    };
    assert_eq!(
        desk_call(&decide),
        Some((
            "desk.decide",
            json!({ "approvalId": "a1", "decision": "deny" })
        ))
    );
    let answer = InboxAct::Answer {
        question_id: "q1".into(),
        choice: Some(1),
        text: Some("   ".into()),
    };
    assert_eq!(
        desk_call(&answer),
        Some(("desk.answer", json!({ "questionId": "q1", "choice": 1 }))),
        "blank words aren't sent"
    );
    let words = InboxAct::Answer {
        question_id: "q1".into(),
        choice: None,
        text: Some(format!("  Either {}", "x".repeat(3000))),
    };
    let (_, input) = desk_call(&words).unwrap();
    assert!(input.get("choice").is_none());
    assert_eq!(input["text"].as_str().unwrap().chars().count(), 2000);
    assert!(input["text"].as_str().unwrap().starts_with("Either"));
    let reply = InboxAct::Reply {
        id: "f1".into(),
        choice: 0,
    };
    assert_eq!(
        desk_call(&reply),
        Some(("desk.reply", json!({ "id": "f1", "choice": 0 })))
    );
    let clear = InboxAct::Clear { id: "f1".into() };
    assert_eq!(
        desk_call(&clear),
        Some(("desk.mark", json!({ "id": "f1", "state": "done" })))
    );
    let seen = InboxAct::Seen { id: "f1".into() };
    assert_eq!(desk_call(&seen).unwrap().1["state"], "seen");
    for own in [
        InboxAct::Open,
        InboxAct::Close,
        InboxAct::Unlock,
        InboxAct::Today,
        InboxAct::Show { url: "/".into() },
    ] {
        assert_eq!(desk_call(&own), None, "{own:?}");
    }
}

#[test]
fn a_shut_desk_asks_for_windows_hello_and_hearths_no_keeps_the_cards() {
    assert_eq!(after(&DeskError::Shut), (InboxPhase::Shut, None, None));
    let (phase, trouble, _) = after(&DeskError::HelloClosed);
    assert_eq!(phase, InboxPhase::Shut);
    assert_eq!(trouble.unwrap().word, "hello_closed");
    let (phase, trouble, refused) = after(&DeskError::NoHello);
    assert_eq!((phase, refused), (InboxPhase::Trouble, None));
    assert!(trouble.unwrap().says.contains("Windows Hello isn't set up"));
    assert_eq!(after(&DeskError::Connect).0, InboxPhase::Trouble);
    let gone = DeskError::Refused {
        code: "not_found".into(),
        message: "That card isn't on the desk.".into(),
    };
    assert_eq!(
        after(&gone),
        (
            InboxPhase::Open,
            None,
            Some("That card isn't on the desk.".into())
        )
    );
}
