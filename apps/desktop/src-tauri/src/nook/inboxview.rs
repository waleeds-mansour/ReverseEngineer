// What the agent dock's Inbox and Nook say to each other (dockinbox.rs has what Nook does): the
// page's InboxAct, inside UiCmd::Inbox, and the InboxView Nook answers with, or sends on its own
// as 'nook://inbox' once Windows Hello has opened the desk or new cards came. A card is one of the
// desk's (packages/modules/src/desk/cards.ts), read here from Hearth's answer to desk.list and
// kept short and plain: unknown kinds are left out, and every string is cut to what the card
// shows, so nothing Hearth sends can make the page draw more than one card's worth. The desk's
// secret never appears here; desk.rs alone holds it.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use specta::Type;

/// What the Inbox page asks.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InboxAct {
    /// The Inbox opened in the notch, which gives it the keyboard: the desk is listed.
    Open,
    /// The Inbox closed.
    Close,
    /// Windows Hello opens the desk.
    Unlock,
    /// A yes or a no to what Pip asks; never Always allow.
    Decide { approval_id: String, yes: bool },
    /// One of a question's choices, from 0, words of your own, or both.
    Answer {
        question_id: String,
        choice: Option<u32>,
        text: Option<String>,
    },
    /// One of the ready replies a finished card offers, from 0.
    Reply { id: String, choice: u32 },
    /// Finished work, the brief or the evening wrap is done with.
    Clear { id: String },
    /// A card was shown.
    Seen { id: String },
    /// Opens a card where it lives, in Hearth's window.
    Show { url: String },
    /// Opens Today in Hearth's window, when the desk can't open here.
    Today,
}

/// Where the desk is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum InboxPhase {
    /// Windows Hello opens it.
    #[default]
    Shut,
    /// Windows Hello is up.
    Opening,
    Open,
    /// It can't open here: no Windows Hello, not connected, Hearth not answering.
    Trouble,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Type)]
pub struct InboxTrouble {
    /// desk_parts.rs's DeskError::word.
    pub word: String,
    pub says: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct InboxCard {
    pub id: String,
    /// approval, question, finished, brief or wrap.
    pub kind: String,
    pub title: String,
    pub line: String,
    pub at: String,
    pub url: String,
    pub outside: bool,
    pub seen: bool,
    pub approval_id: Option<String>,
    pub risk: Option<String>,
    pub question_id: Option<String>,
    pub choices: Vec<String>,
    /// The choice Pip recommends, from 0, when it does.
    pub recommended: Option<u8>,
    pub replies: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Type)]
pub struct InboxView {
    /// Goes up with every view, so a page can drop one that arrives late.
    pub seq: u32,
    /// The Inbox is open: Nook closes it when its window loses the keyboard.
    pub open: bool,
    pub phase: InboxPhase,
    pub cards: Vec<InboxCard>,
    /// How many wait on the desk in all.
    pub total: u32,
    pub trouble: Option<InboxTrouble>,
    /// Hearth said no to the page's last act, in its words.
    pub refused: Option<String>,
}

const KINDS: [&str; 5] = ["approval", "question", "finished", "brief", "wrap"];

/// At most `max` characters.
fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => s[..at].to_string(),
        None => s.to_string(),
    }
}

fn string(v: &Value, k: &str, max: usize) -> String {
    cut(v[k].as_str().unwrap_or(""), max)
}

fn some(v: &Value, k: &str, max: usize) -> Option<String> {
    v[k].as_str().filter(|s| !s.is_empty()).map(|s| cut(s, max))
}

/// Up to `n` of a list's strings, each where the list has it, so the index the page sends back
/// ("2" is choice 2) is Hearth's own: an empty or missing one stays in its place as "", which the
/// page shows no row for, and none are left trailing.
fn list(v: &Value, k: &str, n: usize) -> Vec<String> {
    let all = v[k].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut kept: Vec<String> = all
        .iter()
        .take(n)
        .map(|e| e.as_str().map(|s| cut(s, 200)).unwrap_or_default())
        .collect();
    while kept.last().is_some_and(String::is_empty) {
        kept.pop();
    }
    kept
}

/// One card from desk.list's answer, or None for a kind the Inbox doesn't know.
pub fn card(v: &Value) -> Option<InboxCard> {
    let kind = v["kind"].as_str().filter(|k| KINDS.contains(k))?;
    let id = some(v, "id", 64)?;
    let choices = list(v, "choices", 3);
    let recommended = v["recommended"]
        .as_u64()
        .filter(|&i| choices.get(i as usize).is_some_and(|c| !c.is_empty()))
        .and_then(|i| u8::try_from(i).ok());
    Some(InboxCard {
        id,
        kind: kind.to_string(),
        title: string(v, "title", 120),
        line: string(v, "line", 200),
        at: string(v, "at", 40),
        url: string(v, "url", 200),
        outside: v["outside"] == true,
        seen: v["seen"] == true,
        approval_id: some(v, "approvalId", 64),
        risk: some(v, "risk", 30),
        question_id: some(v, "questionId", 64),
        choices,
        recommended,
        replies: list(v, "replies", 2),
    })
}

/// desk.list's answer: its cards and how many wait in all.
pub fn cards(result: &Value) -> (Vec<InboxCard>, u32) {
    let all = result["cards"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let cards: Vec<InboxCard> = all.iter().filter_map(card).collect();
    let total = result["counts"]["total"]
        .as_u64()
        .unwrap_or(cards.len() as u64);
    (cards, u32::try_from(total).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_page_asks_in_its_own_words() {
        let read = |s: &str| serde_json::from_str::<InboxAct>(s).unwrap();
        assert_eq!(read(r#"{"kind":"open"}"#), InboxAct::Open);
        assert_eq!(
            read(r#"{"kind":"decide","approval_id":"a","yes":false}"#),
            InboxAct::Decide {
                approval_id: "a".into(),
                yes: false
            }
        );
        assert_eq!(
            read(r#"{"kind":"answer","question_id":"q","choice":null,"text":"Either"}"#),
            InboxAct::Answer {
                question_id: "q".into(),
                choice: None,
                text: Some("Either".into())
            }
        );
        // The notch places the Inbox itself: the page no longer says where it is.
        assert!(serde_json::from_str::<InboxAct>(r#"{"kind":"room","top":0}"#).is_err());
        // Always allow isn't something the page can even say.
        assert!(serde_json::from_str::<InboxAct>(r#"{"kind":"always"}"#).is_err());
    }

    #[test]
    fn cards_are_read_short_and_only_of_the_desks_kinds() {
        let listed = json!({
            "cards": [
                {
                    "id": "q1", "kind": "question", "title": "Which room?", "line": "",
                    "at": "2026-10-28T09:00:00.000Z", "url": "/inbox", "outside": false,
                    "seen": false, "questionId": "qq", "choices": ["Small", "Big", "Either", "Four"],
                    "recommended": 1
                },
                { "id": "f1", "kind": "finished", "title": "x".repeat(500), "replies": ["Send it", "", "Shorter", "Third"], "outside": true, "recommended": 0 },
                { "id": "n1", "kind": "note", "title": "Not for the desk" },
                { "kind": "brief", "title": "No id" }
            ],
            "counts": { "total": 7 }
        });
        let (cards, total) = cards(&listed);
        assert_eq!(total, 7);
        assert_eq!(
            cards.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["q1", "f1"]
        );
        assert_eq!(cards[0].question_id.as_deref(), Some("qq"));
        assert_eq!(cards[0].choices, ["Small", "Big", "Either"]);
        // A recommendation counts only for a choice the card has.
        assert_eq!(
            (cards[0].recommended, cards[1].recommended),
            (Some(1), None)
        );
        assert_eq!(cards[1].title.chars().count(), 120);
        // An empty reply keeps its place, so the next is still Hearth's reply 2, past the two
        // the card shows; and none trail.
        assert_eq!(cards[1].replies, ["Send it"]);
        let gap = card(&json!({
            "id": "q2", "kind": "question", "questionId": "qq",
            "choices": ["Small", "", "Either"], "recommended": 1
        }))
        .unwrap();
        assert_eq!(
            gap.choices,
            ["Small", "", "Either"],
            "\"3\" is still Either"
        );
        assert_eq!(gap.recommended, None, "no recommending an empty choice");
        assert!(cards[1].outside && cards[1].approval_id.is_none());
    }
}
