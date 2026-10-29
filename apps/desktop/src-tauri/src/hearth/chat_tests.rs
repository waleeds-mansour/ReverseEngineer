// The notch's chat with Pip (chat.rs), without Tauri or Hearth: what Hearth's answers become in the
// view, whether Pip is still working, and what the panel shows with the desk open or shut.

use super::parts::{
    clip_utf16, is_id, items_of, line_of, status_of, ChatLine, ChatWho, Looking, Next, Page, Turns,
    AWAIT_FOR, LINE_MAX, MISSES, PAGE, SEND_MAX, TAIL,
};
use super::state::{ChatRun, UNSURE};
use super::{may_call, nook_link, COMMANDS, NOOK_LINK};
use crate::hearth::links::{parse, Link};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const ID: &str = "0b5e3c1e-2f7a-4f4e-9d36-3c1e2f7a4f4e";

fn entry(idx: i64, kind: &str, payload: Value, turn: Option<&str>) -> Value {
    json!({ "idx": idx, "kind": kind, "payload": payload, "turnId": turn })
}

fn said(idx: i64, text: &str) -> Value {
    entry(idx, "user_message", json!({ "text": text }), None)
}

fn pip_said(idx: i64, text: &str) -> Value {
    entry(
        idx,
        "assistant_message",
        json!({ "text": text }),
        Some("t1"),
    )
}

/// desk.conversation's answer for one conversation.
fn page(log: Vec<Value>, more: bool, pip: Value, started: Option<&str>) -> Value {
    json!({
        "conversation": { "id": ID, "title": "Plan the week", "startedVia": started,
                          "taintedAt": null, "taintSource": null },
        "log": log,
        "more": more,
        "pip": pip,
        "next": { "replies": [], "outside": false },
    })
}

fn idle() -> Value {
    json!({ "state": "idle", "label": null })
}

fn texts(lines: &[ChatLine]) -> Vec<&str> {
    lines.iter().map(|l| l.text.as_str()).collect()
}

fn shown(id: &str) -> ChatRun {
    let mut r = ChatRun::new();
    r.open = true;
    r.show(Some(id.to_string()));
    r
}

#[test]
fn reads_your_words_pips_and_notices_as_lines() {
    let line = |v: Value| line_of(&v).map(|l| (l.idx, l.who, l.text));
    assert_eq!(line(said(1, " Hi ")), Some((1, ChatWho::You, "Hi".into())));
    assert_eq!(
        line(pip_said(2, "Hello")),
        Some((2, ChatWho::Pip, "Hello".into()))
    );
    let stopped = entry(3, "notice", json!({ "text": "Stopped" }), None);
    assert_eq!(line(stopped), Some((3, ChatWho::Notice, "Stopped".into())));
    let failed = entry(4, "error", json!({}), Some("t1"));
    let said_why = (4, ChatWho::Error, "Something went wrong".into());
    assert_eq!(line(failed), Some(said_why));
    // Pip's working, and empty or odd entries, aren't lines.
    assert_eq!(
        line(entry(5, "tool_call", json!({ "name": "x" }), None)),
        None
    );
    assert_eq!(line(said(6, "   ")), None);
    assert_eq!(line(json!({ "kind": "user_message" })), None);
    // A long answer is cut to what the page shows.
    let long = "a".repeat(LINE_MAX + 10);
    assert_eq!(line_of(&said(7, &long)).unwrap().text.len(), LINE_MAX);
}

#[test]
fn folds_turns_as_nooks_window_does() {
    let mut t = Turns::default();
    assert!(!t.busy());
    t.take(&said(0, "Plan my week"));
    assert!(t.busy(), "waits for Pip to start");
    t.take(&entry(1, "turn_started", json!({}), Some("t1")));
    t.take(&pip_said(2, "On it"));
    assert!(t.busy(), "the turn runs");
    t.take(&entry(3, "turn_finished", json!({}), Some("t1")));
    assert!(!t.busy());
    t.take(&entry(4, "turn_started", json!({}), Some("t2")));
    t.take(&entry(5, "error", json!({ "message": "No" }), Some("t2")));
    assert!(!t.busy(), "a failed turn has ended");
    t.take(&entry(6, "notice", json!({ "retrying": true }), None));
    assert!(t.busy(), "Retry waits for Pip again");
}

#[test]
fn says_what_pip_is_on_as_the_dock_does() {
    let s = |v: Value| status_of(&v);
    let asked = json!({ "state": "thinking", "label": "what you asked" });
    assert_eq!(s(asked).as_deref(), Some("Thinking about what you asked"));
    let brief = json!({ "state": "working", "label": "your morning brief" });
    assert_eq!(s(brief).as_deref(), Some("Working on your morning brief"));
    let bare = json!({ "state": "working", "label": " " });
    assert_eq!(s(bare).as_deref(), Some("Working"));
    assert_eq!(s(idle()), None);
    assert_eq!(s(Value::Null), None);
}

#[test]
fn lists_the_desks_recent_conversations() {
    let listed = items_of(&json!({ "conversations": [
        { "id": ID, "title": "Plan the week", "at": "2026-10-29T08:00:00.000Z", "working": true },
        { "title": "No id" },
    ]}));
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].title.as_str(), listed[0].working),
        ("Plan the week", true)
    );
    assert!(items_of(&json!({})).is_empty());
}

#[test]
fn pages_back_and_takes_what_came_after_at_the_desk() {
    let mut r = shown(ID);
    let newest: Vec<Value> = (50..100).map(|i| said(i, &format!("L{i}"))).collect();
    r.took_page(&page(newest, true, idle(), None), Page::Newest);
    assert_eq!((r.lines.len(), r.older, r.last), (PAGE, true, 99));
    assert_eq!(r.title, "Plan the week");
    let back: Vec<Value> = (0..50).map(|i| said(i, &format!("L{i}"))).collect();
    r.took_page(&page(back, false, idle(), None), Page::Older);
    assert_eq!(
        (r.lines.len(), r.older, r.lines[0].text.as_str()),
        (100, false, "L0")
    );
    // What came after joins the end once, even when it comes again.
    let after = vec![pip_said(100, "Done"), pip_said(101, "And more")];
    r.took_page(&page(after.clone(), false, idle(), None), Page::After);
    r.took_page(&page(after, false, idle(), None), Page::After);
    assert_eq!(texts(&r.lines[98..]), ["L98", "L99", "Done", "And more"]);
    assert_eq!((r.last, r.older), (101, false));
}

#[test]
fn shows_the_outside_mark_and_ready_replies() {
    let mut r = shown(ID);
    let mut answer = page(vec![pip_said(1, "Read it")], false, idle(), Some("device"));
    answer["conversation"]["taintedAt"] = json!("2026-10-29T08:00:00.000Z");
    answer["conversation"]["taintSource"] = json!("an email from Sam");
    answer["next"] = json!({ "replies": ["Send it", "Shorter", "Third"], "outside": true });
    r.took_page(&answer, Page::Newest);
    let (v, _) = r.view(true, NOOK_LINK, Instant::now());
    assert_eq!(v.outside.as_deref(), Some("an email from Sam"));
    assert_eq!((v.replies.len(), v.replies_outside), (2, true));
    assert!(r.mine);
    // Read without saying what: "outside content", as Nook's badge says.
    answer["conversation"]["taintSource"] = Value::Null;
    r.took_page(&answer, Page::Newest);
    assert_eq!(r.outside.as_deref(), Some("outside content"));
}

#[test]
fn a_message_sent_shows_at_once_and_waits_for_pip() {
    let now = Instant::now();
    let mut r = ChatRun::new();
    r.open = true;
    r.show(None);
    r.replies = vec!["Old".into()];
    r.sent(ID, 0, "Plan my week\nplease", now);
    assert_eq!(r.conversation.as_deref(), Some(ID));
    assert_eq!((r.title.as_str(), r.mine), ("Plan my week", true));
    assert!(r.replies.is_empty(), "you wrote since they were offered");
    assert!(r.working(now));
    let (v, _) = r.view(false, NOOK_LINK, now);
    assert_eq!(v.status.as_deref(), Some("Thinking"));
    assert_eq!(v.recent[0].id, ID, "the switcher keeps the app's own");
    // Your own words coming back don't answer it; Pip's do.
    r.took_page(
        &page(vec![said(0, "Plan my week")], false, idle(), Some("device")),
        Page::After,
    );
    assert!(r.working(now));
    r.took_page(
        &page(vec![pip_said(2, "Here's a plan")], false, idle(), None),
        Page::After,
    );
    assert!(!r.working(now));
    // Pip seen on it, and then done.
    r.sent(ID, 3, "Thanks", now);
    let thinking = json!({ "state": "thinking", "label": "what you asked" });
    r.took_page(&page(vec![], false, thinking, None), Page::After);
    assert_eq!(r.awaiting, None);
    let (v, _) = r.view(true, NOOK_LINK, now);
    assert_eq!(v.status.as_deref(), Some("Thinking about what you asked"));
    r.took_page(&page(vec![], false, idle(), None), Page::After);
    assert!(!r.working(now));
    // Pip never seen: the panel stops looking after a while.
    r.sent(ID, 4, "Hello?", now);
    assert!(r.working(now));
    assert!(!r.working(now + AWAIT_FOR));
}

#[test]
fn reads_the_apps_own_with_the_token_from_the_whole_log() {
    let mut r = shown(ID);
    let mut log: Vec<Value> = (0..60).map(|i| said(i, &format!("L{i}"))).collect();
    log.push(entry(60, "turn_started", json!({}), Some("t1")));
    let get = |log: Vec<Value>| {
        json!({ "conversation": { "id": ID, "title": "Mine", "startedVia": "device",
                                  "taintedAt": null }, "log": log, "next": { "replies": [] } })
    };
    r.took_log(&get(log), true);
    assert_eq!(
        (r.lines.len(), r.held.len(), r.older, r.last),
        (PAGE, 10, true, 60)
    );
    assert!(r.working(Instant::now()), "a turn runs");
    r.older_from_held();
    assert_eq!(
        (r.lines.len(), r.older, r.lines[0].text.as_str()),
        (60, false, "L0")
    );
    let after = vec![
        pip_said(61, "Done"),
        entry(62, "turn_finished", json!({}), Some("t1")),
    ];
    r.took_log(&get(after), false);
    assert_eq!(r.lines.last().map(|l| l.text.as_str()), Some("Done"));
    assert!(!r.working(Instant::now()));
    let (v, _) = r.view(false, NOOK_LINK, Instant::now());
    assert!(!v.locked, "the app's own reads without the desk");
}

#[test]
fn another_conversation_needs_the_desk_once_it_shuts() {
    let now = Instant::now();
    let mut r = shown(ID);
    let pip = json!({ "state": "working", "label": "your brief" });
    r.took_page(
        &page(vec![pip_said(1, "Secret plans")], false, pip, None),
        Page::Newest,
    );
    let (open, _) = r.view(true, NOOK_LINK, now);
    assert!(!open.locked && open.working);
    // Windows locked: nothing of it shows, and Windows Hello opens it again.
    let (shut, changed) = r.view(false, NOOK_LINK, now);
    assert!(changed && shut.locked && !shut.working);
    // Not even its title, which is made from its first words.
    assert!(shut.lines.is_empty() && shut.status.is_none() && shut.title.is_empty());
    // The token refused it outright.
    r.refuse();
    assert!(r.lines.is_empty() && r.refused);
}

#[test]
fn numbers_a_view_only_when_it_changed() {
    let now = Instant::now();
    let mut r = shown(ID);
    let (a, first) = r.view(true, NOOK_LINK, now);
    let (b, again) = r.view(true, NOOK_LINK, now);
    assert!(first && !again);
    assert_eq!(a.seq, b.seq);
    r.trouble = Some("Hearth isn't answering right now.".into());
    let (c, changed) = r.view(true, NOOK_LINK, now);
    assert!(changed && c.seq > b.seq);
    assert_eq!(c.link, NOOK_LINK);
}

#[test]
fn switching_conversations_keeps_nothing_of_the_last_but_the_switcher() {
    let mut r = ChatRun::new();
    r.open = true;
    r.show(None);
    r.sent(ID, 0, "Mine", Instant::now());
    r.watch = 3;
    let (ver, poll) = (r.ver, r.poll);
    r.show(None);
    assert!(r.lines.is_empty() && r.conversation.is_none() && r.awaiting.is_none());
    // Looking starts afresh; watching the desk goes on.
    assert_eq!((r.ver, r.poll, r.watch), (ver + 1, poll + 1, 3));
    assert_eq!(
        (r.title.as_str(), r.known.len(), r.open),
        ("New conversation", 1, true)
    );
}

#[test]
fn only_the_chats_commands_and_only_ids() {
    for c in COMMANDS {
        assert!(may_call(c), "{c}");
    }
    assert!(!may_call("nook_ui") && !may_call("get_app_settings"));
    assert!(is_id(ID));
    assert!(!is_id("../today") && !is_id(&ID.replace('-', "x")) && !is_id(""));
}

#[test]
fn looking_stops_after_five_failed_looks_in_a_row() {
    let t = Instant::now();
    let mut look = Looking::new(4, t);
    for _ in 1..MISSES {
        assert_eq!(look.after(false, 4, true, t), Next::Again);
    }
    assert_eq!(look.after(false, 4, true, t), Next::GiveUp);
    // A look that worked in between starts the count again.
    let mut look = Looking::new(4, t);
    for _ in 1..MISSES {
        look.after(false, 4, true, t);
    }
    assert_eq!(look.after(true, 4, true, t), Next::Again);
    assert_eq!(look.after(false, 4, true, t), Next::Again);
}

#[test]
fn looking_stops_after_five_minutes_of_pip_at_work_with_no_new_line() {
    let t = Instant::now();
    let at = |s: u64| t + Duration::from_secs(s);
    let mut look = Looking::new(4, t);
    assert_eq!(look.after(true, 4, true, at(200)), Next::Again);
    // A new line: five minutes from then.
    assert_eq!(look.after(true, 5, true, at(250)), Next::Again);
    assert_eq!(look.after(true, 5, true, at(549)), Next::Again);
    assert_eq!(look.after(true, 5, true, at(550)), Next::GiveUp);
    // Pip done: a few seconds more for its ready replies, then done.
    let mut look = Looking::new(4, t);
    assert_eq!(look.after(true, 4, false, at(1)), Next::Again);
    assert_eq!(look.after(true, 4, false, at(1) + TAIL), Next::Done);
}

#[test]
fn giving_up_shows_pip_resting_until_something_looks_again() {
    let now = Instant::now();
    let mut r = shown(ID);
    let pip = json!({ "state": "working", "label": null });
    r.took_page(&page(vec![said(1, "Hi")], false, pip, None), Page::Newest);
    r.sent(ID, 2, "More", now);
    assert!(r.working(now));
    r.give_up();
    assert!(!r.working(now) && r.status.is_none() && r.awaiting.is_none());
    let (v, _) = r.view(true, NOOK_LINK, now);
    assert!(!v.working && v.status.is_none());
}

#[test]
fn words_hearth_didnt_confirm_may_have_gone_until_they_show() {
    let now = Instant::now();
    let mut r = shown(ID);
    r.took_page(
        &page(vec![said(1, "Hi")], false, idle(), None),
        Page::Newest,
    );
    r.unsure = Some(("Book Friday".into(), r.last));
    assert_eq!(
        r.view(true, NOOK_LINK, now).0.trouble.as_deref(),
        Some(UNSURE)
    );
    // The same words said before don't count.
    assert_eq!(r.went("Hi", 1), None);
    let came = page(vec![said(2, "Book Friday")], false, idle(), None);
    r.took_page(&came, Page::After);
    assert!(r.unsure.is_none());
    assert_eq!(r.went("Book Friday", 1), Some(2));
    assert_eq!(r.view(true, NOOK_LINK, now).0.trouble, None);
}

#[test]
fn cuts_a_message_as_hearth_counts_it_and_opens_the_conversation_shown_in_nook() {
    assert_eq!(clip_utf16("abc", 3), ("abc".into(), false));
    // An emoji is two UTF-16 units: it goes whole or not at all.
    assert_eq!(clip_utf16("ab😀", 3), ("ab".into(), true));
    assert_eq!(clip_utf16("ab😀", 4), ("ab😀".into(), false));
    let (cut, was) = clip_utf16(&"😀".repeat(SEND_MAX), SEND_MAX);
    assert!(was && cut.chars().count() == SEND_MAX / 2);
    // "Open in Nook" opens the conversation shown, as a page deeplink.rs takes.
    let link = nook_link(Some(ID));
    assert_eq!(parse(&link), Ok(Link::Open(format!("/chat/{ID}"))));
    assert_eq!(nook_link(None), NOOK_LINK);
    assert_eq!(nook_link(Some("../today")), NOOK_LINK);
}

#[test]
fn windows_hello_unlocking_for_the_chat_is_what_keeps_the_notch_open() {
    assert!(!super::unlocking());
    super::run().unlocking = true;
    assert!(
        super::unlocking(),
        "the prompt taking the keyboard leaves the chat open"
    );
    super::run().unlocking = false;
}
