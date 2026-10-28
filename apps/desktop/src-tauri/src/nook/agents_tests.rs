use super::*;

fn fine() -> ServicesView {
    ServicesView {
        checked: true,
        address_set: true,
        server: Health::Ok,
        worker: Health::Ok,
        pip: Health::Ok,
        ..ServicesView::default()
    }
}

fn pip(mood: PipMood, waiting: u32) -> PipView {
    PipView {
        mood,
        waiting,
        ..PipView::default()
    }
}

/// The feed open, with everything well and Pip resting.
fn calm() -> Live {
    Live {
        worker: Health::Ok,
        pip: Health::Ok,
        sync: Health::Ok,
        other: Health::Ok,
        ..Live::default()
    }
}

fn on(turn: Turn, label: &str) -> Live {
    Live {
        turn,
        label: label.into(),
        ..calm()
    }
}

fn states(dots: &[AgentDot]) -> Vec<(&str, AgentState)> {
    dots.iter().map(|d| (d.id.as_str(), d.state)).collect()
}

#[test]
fn pip_works_needs_you_finishes_and_rests() {
    let s = fine();
    let at = |mood, waiting| pip_dot(&pip(mood, waiting), &s, None);
    assert_eq!(at(PipMood::Listening, 0).state, AgentState::Working);
    assert_eq!(at(PipMood::Thinking, 0).line, "Thinking");
    assert_eq!(at(PipMood::Happy, 0).state, AgentState::Done);
    assert_eq!(at(PipMood::Idle, 0).state, AgentState::Idle);
    let waiting = at(PipMood::Idle, 2);
    assert_eq!(waiting.state, AgentState::NeedsYou);
    assert_eq!(waiting.line, "2 things wait for you");
    assert_eq!(at(PipMood::Happy, 1).line, "1 thing waits for you");
    assert_eq!(
        at(PipMood::Thinking, 3).state,
        AgentState::Working,
        "work under way shows first"
    );
    assert_eq!(waiting.kind, AgentKind::Pip);
}

#[test]
fn pip_whose_service_is_down_needs_you_and_a_paused_one_rests() {
    let down = ServicesView {
        pip: Health::Down,
        ..fine()
    };
    let dot = pip_dot(&pip(PipMood::Idle, 0), &down, None);
    assert_eq!(dot.state, AgentState::NeedsYou);
    assert_eq!(dot.line, "Pip isn't answering");
    let paused = ServicesView {
        pip_paused: true,
        ..fine()
    };
    assert_eq!(
        pip_dot(&pip(PipMood::Idle, 0), &paused, None).line,
        "Paused"
    );
    // Before the first check, nothing is known to be down.
    let unchecked = ServicesView {
        pip: Health::Down,
        ..ServicesView::default()
    };
    assert_eq!(
        pip_dot(&pip(PipMood::Idle, 0), &unchecked, None).state,
        AgentState::Idle
    );
}

#[test]
fn services_join_the_dock_only_while_they_need_the_owner() {
    let idle = pip(PipMood::Idle, 0);
    assert_eq!(
        states(&dots(&idle, &fine(), None)),
        vec![("pip", AgentState::Idle)]
    );
    assert_eq!(
        dots(&idle, &ServicesView::default(), None).len(),
        1,
        "not checked yet"
    );
    let bad = ServicesView {
        server: Health::Down,
        worker: Health::Trouble,
        other_failing: true,
        ..fine()
    };
    let all = dots(&idle, &bad, None);
    assert_eq!(
        states(&all),
        vec![
            ("pip", AgentState::Idle),
            ("server", AgentState::NeedsYou),
            ("worker", AgentState::NeedsYou),
            ("watched", AgentState::NeedsYou),
        ]
    );
    assert_eq!(all[1].line, "Not answering");
    assert_eq!(all[2].line, "Having trouble");
    assert!(all[1..].iter().all(|d| d.kind == AgentKind::Service));
    let unpaired = ServicesView {
        address_set: false,
        server: Health::Unknown,
        ..fine()
    };
    let all = dots(&idle, &unpaired, None);
    assert_eq!(all[1].id, "server");
    assert_eq!(all[1].line, "Not connected");
}

#[test]
fn with_the_feed_open_pip_says_what_the_server_says_it_is_on() {
    let s = fine();
    let at = |mood, live: &Live| pip_dot(&pip(mood, 0), &s, Some(live));
    let brief = on(Turn::Working, "your morning brief");
    let dot = at(PipMood::Idle, &brief);
    assert_eq!(dot.state, AgentState::Working);
    assert_eq!(dot.line, "Working on your morning brief");
    assert_eq!(
        at(PipMood::Idle, &on(Turn::Thinking, "what you asked")).line,
        "Thinking about what you asked"
    );
    assert_eq!(at(PipMood::Idle, &on(Turn::Working, "")).line, "Working");
    assert_eq!(at(PipMood::Idle, &calm()).line, "Resting");
    // This PC's own call and its answer show first; the server's turn shows once they're over.
    assert_eq!(at(PipMood::Listening, &brief).line, "Listening");
    assert_eq!(at(PipMood::Happy, &brief).state, AgentState::Done);
    // Paused stops Pip's own work, not what the owner asks, so a turn still shows.
    let paused = Live {
        paused: true,
        ..calm()
    };
    assert_eq!(at(PipMood::Idle, &paused).line, "Paused");
    let asked_while_paused = Live {
        paused: true,
        ..on(Turn::Thinking, "what you asked")
    };
    assert_eq!(
        at(PipMood::Idle, &asked_while_paused).state,
        AgentState::Working
    );
    // A Pip that isn't answering needs the owner, whatever its last turn said.
    let down = Live {
        pip: Health::Down,
        ..brief.clone()
    };
    let dot = at(PipMood::Idle, &down);
    assert_eq!(
        (dot.state, dot.line.as_str()),
        (AgentState::NeedsYou, "Pip isn't answering")
    );
}

#[test]
fn with_the_feed_open_yeses_get_their_own_dot_and_the_chips_count_stays_on_the_bar() {
    let s = fine();
    // Notifications waiting on the bar's chip don't make Pip's dot need the owner: what waits
    // for a yes has its own, which goes once it is answered anywhere.
    let waiting = pip(PipMood::Idle, 3);
    let none = dots(&waiting, &s, Some(&calm()));
    assert_eq!(states(&none), vec![("pip", AgentState::Idle)]);
    let two = Live {
        approvals: 2,
        ..calm()
    };
    let all = dots(&waiting, &s, Some(&two));
    assert_eq!(
        states(&all),
        vec![
            ("pip", AgentState::Idle),
            ("approvals", AgentState::NeedsYou)
        ]
    );
    assert_eq!(all[1].kind, AgentKind::Approvals);
    assert_eq!(all[1].line, "2 things wait for your yes");
    let one = Live {
        approvals: 1,
        ..calm()
    };
    assert_eq!(
        dots(&waiting, &s, Some(&one))[1].line,
        "1 thing waits for your yes"
    );
}

#[test]
fn with_the_feed_open_services_are_the_servers_reading() {
    let idle = pip(PipMood::Idle, 0);
    // The tray's last reading is older than the feed: the feed is open, so the server answers.
    let stale_tray = ServicesView {
        server: Health::Down,
        worker: Health::Down,
        other_failing: true,
        ..fine()
    };
    assert_eq!(
        states(&dots(&idle, &stale_tray, Some(&calm()))),
        vec![("pip", AgentState::Idle)]
    );
    let bad = Live {
        approvals: 1,
        worker: Health::Trouble,
        sync: Health::Down,
        other: Health::Down,
        ..calm()
    };
    let all = dots(&idle, &ServicesView::default(), Some(&bad));
    let ids: Vec<&str> = all.iter().map(|d| d.id.as_str()).collect();
    assert_eq!(ids, vec!["pip", "approvals", "worker", "sync", "watched"]);
    assert_eq!(all[2].line, "Having trouble");
    assert_eq!(all[3].line, "Not syncing");
    let slow_sync = Live {
        sync: Health::Trouble,
        other: Health::Trouble,
        ..calm()
    };
    let all = dots(&idle, &fine(), Some(&slow_sync));
    assert_eq!(
        states(&all),
        vec![("pip", AgentState::Idle), ("sync", AgentState::NeedsYou)],
        "only something else failing outright needs the owner, as the tray reads it"
    );
}

#[test]
fn each_dot_counts_what_waits_behind_it_for_the_docks_badge() {
    let s = fine();
    let total = |dots: &[AgentDot]| dots.iter().map(|d| d.waiting).sum::<u32>();
    // Without the feed, what waits on the bar's Pip chip is Pip's.
    let alone = dots(&pip(PipMood::Idle, 3), &s, None);
    assert_eq!((alone[0].waiting, total(&alone)), (3, 3));
    // Working on something for this PC, Pip still counts what it asked.
    assert_eq!(pip_dot(&pip(PipMood::Thinking, 2), &s, None).waiting, 2);
    // With the feed open, the yeses are counted on their own dot, and the chip's count is the
    // bar's alone; a service in trouble waits on nothing the owner can answer.
    let feed = Live {
        approvals: 4,
        worker: Health::Down,
        ..calm()
    };
    let all = dots(&pip(PipMood::Idle, 3), &s, Some(&feed));
    let counts: Vec<(&str, u32)> = all.iter().map(|d| (d.id.as_str(), d.waiting)).collect();
    assert_eq!(counts, vec![("pip", 0), ("approvals", 4), ("worker", 0)]);
    assert_eq!(total(&all), 4);
}
