// The agent dock's dots, from what this PC already knows. Pip is always there: working while it
// listens or thinks for this PC, needing the owner while something waits for them on Hearth or
// its service isn't answering, done for the moment an answer comes back, and resting otherwise.
// Hearth's own services join it only while they need the owner, one dot each: the server or the
// background work having trouble or not answering, this app without Hearth's address, or
// something else Hearth watches failing. Until the tray's first check comes back, Pip is alone.

use super::chrome::{AgentDot, AgentKind, AgentState, Health, PipMood, PipView, ServicesView};

fn dot(id: &str, label: &str, kind: AgentKind, state: AgentState, line: String) -> AgentDot {
    AgentDot {
        id: id.into(),
        label: label.into(),
        kind,
        state,
        line,
    }
}

fn waits(n: u32) -> String {
    if n == 1 {
        "1 thing waits for you".into()
    } else {
        format!("{n} things wait for you")
    }
}

/// Pip's dot. Work going on for this PC shows first, since the owner is in the middle of it;
/// what waits for them shows as soon as it is over.
pub fn pip_dot(pip: &PipView, services: &ServicesView) -> AgentDot {
    let (state, line) = match pip.mood {
        PipMood::Listening => (AgentState::Working, "Listening".to_string()),
        PipMood::Thinking => (AgentState::Working, "Thinking".to_string()),
        _ if pip.waiting > 0 => (AgentState::NeedsYou, waits(pip.waiting)),
        _ if services.checked && services.pip == Health::Down => {
            (AgentState::NeedsYou, "Pip isn't answering".to_string())
        }
        PipMood::Happy => (AgentState::Done, "Answered".to_string()),
        PipMood::Idle if services.pip_paused => (AgentState::Idle, "Paused".to_string()),
        PipMood::Idle => (AgentState::Idle, "Resting".to_string()),
    };
    dot("pip", "Pip", AgentKind::Pip, state, line)
}

fn troubled(h: Health) -> Option<&'static str> {
    match h {
        Health::Down => Some("Not answering"),
        Health::Trouble => Some("Having trouble"),
        Health::Ok | Health::Unknown => None,
    }
}

/// Every dot, Pip first.
pub fn dots(pip: &PipView, services: &ServicesView) -> Vec<AgentDot> {
    let mut all = vec![pip_dot(pip, services)];
    if !services.checked {
        return all;
    }
    let needs = |id: &str, label: &str, line: &str| {
        dot(
            id,
            label,
            AgentKind::Service,
            AgentState::NeedsYou,
            line.into(),
        )
    };
    if !services.address_set {
        all.push(needs("server", "Nook's server", "Not connected"));
    } else if let Some(line) = troubled(services.server) {
        all.push(needs("server", "Nook's server", line));
    }
    if let Some(line) = troubled(services.worker) {
        all.push(needs("worker", "Background work", line));
    }
    if services.other_failing {
        all.push(needs(
            "watched",
            "Nook",
            "Something Nook watches is failing",
        ));
    }
    all
}

#[cfg(test)]
mod tests {
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

    fn states(dots: &[AgentDot]) -> Vec<(&str, AgentState)> {
        dots.iter().map(|d| (d.id.as_str(), d.state)).collect()
    }

    #[test]
    fn pip_works_needs_you_finishes_and_rests() {
        let s = fine();
        let at = |mood, waiting| pip_dot(&pip(mood, waiting), &s);
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
        let dot = pip_dot(&pip(PipMood::Idle, 0), &down);
        assert_eq!(dot.state, AgentState::NeedsYou);
        assert_eq!(dot.line, "Pip isn't answering");
        let paused = ServicesView {
            pip_paused: true,
            ..fine()
        };
        assert_eq!(pip_dot(&pip(PipMood::Idle, 0), &paused).line, "Paused");
        // Before the first check, nothing is known to be down.
        let unchecked = ServicesView {
            pip: Health::Down,
            ..ServicesView::default()
        };
        assert_eq!(
            pip_dot(&pip(PipMood::Idle, 0), &unchecked).state,
            AgentState::Idle
        );
    }

    #[test]
    fn services_join_the_dock_only_while_they_need_the_owner() {
        let idle = pip(PipMood::Idle, 0);
        assert_eq!(
            states(&dots(&idle, &fine())),
            vec![("pip", AgentState::Idle)]
        );
        assert_eq!(
            dots(&idle, &ServicesView::default()).len(),
            1,
            "not checked yet"
        );
        let bad = ServicesView {
            server: Health::Down,
            worker: Health::Trouble,
            other_failing: true,
            ..fine()
        };
        let all = dots(&idle, &bad);
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
        let all = dots(&idle, &unpaired);
        assert_eq!(all[1].id, "server");
        assert_eq!(all[1].line, "Not connected");
    }
}
