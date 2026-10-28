// What Hearth's server says Pip and Nook are doing, from the `status` events on the notify feed
// (hearth/notify.rs; the server's side is apps/server/src/routes/desktop.ts and deskLite in
// packages/modules): what Pip is on, in a few words, whether its own work is paused, how many
// things wait for the owner's yes, and the server's own health readings. It holds nobody's words.
// It counts only while the feed is open: once that closes, the dock goes back to what this PC
// knows itself (agents.rs).

use super::chrome::Health;
use serde::Deserialize;

/// What Pip is on, as the server says: thinking about something the owner asked, whose answer
/// they wait for, or working on anything else.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Turn {
    #[default]
    Idle,
    Thinking,
    Working,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Live {
    pub turn: Turn,
    /// What it's on, to follow "Working on": "your morning brief". Empty while it rests.
    pub label: String,
    /// Pip's own work is paused.
    pub paused: bool,
    /// How many things wait for the owner's yes, up to MOST_APPROVALS.
    pub approvals: u32,
    pub worker: Health,
    pub pip: Health,
    /// The worst of the syncs.
    pub sync: Health,
    /// The worst of everything else Hearth watches: the disk, backups, schedules.
    pub other: Health,
}

/// The longest label the dock shows; the server's are shorter.
const LABEL_MAX: usize = 60;
/// The most yeses the dock counts.
pub const MOST_APPROVALS: u32 = 99;

#[derive(Deserialize, Default)]
#[serde(default)]
struct Wire {
    pip: WirePip,
    approvals: u32,
    health: WireHealth,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct WirePip {
    state: String,
    label: Option<String>,
    paused: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct WireHealth {
    worker: String,
    jarvis: String,
    sync: String,
    other: String,
}

/// A component as the server judges it: failing is down, as the tray reads system.status.
fn health(s: &str) -> Health {
    match s {
        "ok" => Health::Ok,
        "degraded" => Health::Trouble,
        "failing" => Health::Down,
        _ => Health::Unknown,
    }
}

/// A status from the feed, or None when it doesn't read as one. Anything it doesn't know reads
/// as unknown or resting, never as trouble.
pub fn parse(data: &str) -> Option<Live> {
    let w: Wire = serde_json::from_str(data).ok()?;
    let turn = match w.pip.state.as_str() {
        "thinking" => Turn::Thinking,
        "working" => Turn::Working,
        _ => Turn::Idle,
    };
    let label: String = match turn {
        Turn::Idle => String::new(),
        _ => w
            .pip
            .label
            .unwrap_or_default()
            .chars()
            .filter(|c| !c.is_control())
            .take(LABEL_MAX)
            .collect::<String>()
            .trim()
            .to_string(),
    };
    Some(Live {
        turn,
        label,
        paused: w.pip.paused,
        approvals: w.approvals.min(MOST_APPROVALS),
        worker: health(&w.health.worker),
        pip: health(&w.health.jarvis),
        sync: health(&w.health.sync),
        other: health(&w.health.other),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_servers_status() {
        let live = parse(
            r#"{"pip":{"state":"working","label":"your morning brief","paused":true},
                "approvals":2,
                "health":{"worker":"ok","jarvis":"degraded","sync":"failing","other":"unknown"}}"#,
        )
        .unwrap();
        assert_eq!(
            live,
            Live {
                turn: Turn::Working,
                label: "your morning brief".into(),
                paused: true,
                approvals: 2,
                worker: Health::Ok,
                pip: Health::Trouble,
                sync: Health::Down,
                other: Health::Unknown,
            }
        );
    }

    #[test]
    fn what_it_doesnt_know_rests_and_odd_words_are_cut() {
        let live =
            parse(r#"{"pip":{"state":"dreaming","label":"x"},"health":{"worker":"meh"}}"#).unwrap();
        assert_eq!(live.turn, Turn::Idle);
        assert_eq!(live.label, "", "a resting Pip has no label");
        assert_eq!(live.worker, Health::Unknown);
        assert_eq!(parse("{}"), Some(Live::default()));
        let long = format!(
            r#"{{"pip":{{"state":"thinking","label":"a\u0007b {}"}},"approvals":4000}}"#,
            "y".repeat(200)
        );
        let live = parse(&long).unwrap();
        assert!(live.label.starts_with("ab y"));
        assert_eq!(live.label.chars().count(), LABEL_MAX);
        assert_eq!(live.approvals, MOST_APPROVALS);
        for bad in [
            "",
            "not json",
            r#"{"approvals":-1}"#,
            r#"{"pip":"working"}"#,
        ] {
            assert_eq!(parse(bad), None, "{bad:?}");
        }
    }
}
