// The agent dock's dots. Pip is always there. This PC's own calls to Pip come first: working while
// it listens or thinks for this PC, and done for the moment an answer comes back. A Pip that isn't
// answering needs the owner. Otherwise, while Hearth's notify feed is open, Pip's dot says what the
// server says (live.rs): thinking about something the owner asked, working on something else by
// its few words of label, paused or resting; without the feed it needs the owner while
// notifications wait on the bar's Pip chip, as before the feed said more. What waits for the
// owner's yes has a dot of its own while anything does, and clicking it opens Today, where those
// are listed. Hearth's own services join only while they need the owner, one dot each: the server
// not answering or this app without its address, the background work or the syncs having trouble,
// or something else Hearth watches failing. While the feed is open the server is answering and
// the rest is the server's own reading; otherwise it is the tray's, and until the tray's first
// check comes back, Pip is alone. Each dot also counts what behind it waits for the owner, the
// yeses and what Pip asks, and the dock's count badge adds those up.

use super::chrome::{AgentDot, AgentKind, AgentState, Health, PipMood, PipView, ServicesView};
use super::live::{Live, Turn};

fn dot(id: &str, label: &str, kind: AgentKind, state: AgentState, line: String) -> AgentDot {
    AgentDot {
        id: id.into(),
        label: label.into(),
        kind,
        state,
        line,
        waiting: 0,
    }
}

fn waits(n: u32) -> String {
    if n == 1 {
        "1 thing waits for you".into()
    } else {
        format!("{n} things wait for you")
    }
}

fn yeses(n: u32) -> String {
    if n == 1 {
        "1 thing waits for your yes".into()
    } else {
        format!("{n} things wait for your yes")
    }
}

/// What the server says Pip is on, as its line: "Working on your morning brief".
fn turn_line(live: &Live) -> Option<String> {
    let (verb, alone) = match live.turn {
        Turn::Idle => return None,
        Turn::Thinking => ("Thinking about", "Thinking"),
        Turn::Working => ("Working on", "Working"),
    };
    Some(if live.label.is_empty() {
        alone.to_string()
    } else {
        format!("{verb} {}", live.label)
    })
}

/// Pip's dot. Work going on for this PC shows first, since the owner is in the middle of it.
pub fn pip_dot(pip: &PipView, services: &ServicesView, live: Option<&Live>) -> AgentDot {
    let down = (services.checked && services.pip == Health::Down)
        || live.is_some_and(|l| l.pip == Health::Down);
    let paused = services.pip_paused || live.is_some_and(|l| l.paused);
    // Without the feed, what waits on the bar's Pip chip is what Pip asks of the owner.
    let asks = if live.is_none() { pip.waiting } else { 0 };
    let (state, line) = match pip.mood {
        PipMood::Listening => (AgentState::Working, "Listening".to_string()),
        PipMood::Thinking => (AgentState::Working, "Thinking".to_string()),
        _ if asks > 0 => (AgentState::NeedsYou, waits(asks)),
        _ if down => (AgentState::NeedsYou, "Pip isn't answering".to_string()),
        PipMood::Happy => (AgentState::Done, "Answered".to_string()),
        PipMood::Idle => match live.and_then(turn_line) {
            Some(line) => (AgentState::Working, line),
            None if paused => (AgentState::Idle, "Paused".to_string()),
            None => (AgentState::Idle, "Resting".to_string()),
        },
    };
    AgentDot {
        waiting: asks,
        ..dot("pip", "Pip", AgentKind::Pip, state, line)
    }
}

fn troubled(h: Health) -> Option<&'static str> {
    match h {
        Health::Down => Some("Not answering"),
        Health::Trouble => Some("Having trouble"),
        Health::Ok | Health::Unknown => None,
    }
}

fn needs(id: &str, label: &str, line: &str) -> AgentDot {
    dot(
        id,
        label,
        AgentKind::Service,
        AgentState::NeedsYou,
        line.into(),
    )
}

/// Every dot, Pip first, then what waits for a yes, then the services.
pub fn dots(pip: &PipView, services: &ServicesView, live: Option<&Live>) -> Vec<AgentDot> {
    let mut all = vec![pip_dot(pip, services, live)];
    if let Some(n) = live.map(|l| l.approvals).filter(|n| *n > 0) {
        all.push(AgentDot {
            waiting: n,
            ..dot(
                "approvals",
                "Needs your yes",
                AgentKind::Approvals,
                AgentState::NeedsYou,
                yeses(n),
            )
        });
    }
    if let Some(l) = live {
        // The feed is open, so the server is answering.
        if let Some(line) = troubled(l.worker) {
            all.push(needs("worker", "Background work", line));
        }
        match l.sync {
            Health::Down => all.push(needs("sync", "Nook's syncs", "Not syncing")),
            Health::Trouble => all.push(needs("sync", "Nook's syncs", "Having trouble")),
            Health::Ok | Health::Unknown => {}
        }
        if l.other == Health::Down {
            all.push(needs(
                "watched",
                "Nook",
                "Something Nook watches is failing",
            ));
        }
        return all;
    }
    if !services.checked {
        return all;
    }
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
#[path = "agents_tests.rs"]
mod tests;
