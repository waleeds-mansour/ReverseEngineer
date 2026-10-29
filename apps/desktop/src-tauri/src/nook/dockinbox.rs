// The agent dock's Inbox, Nook's side (inboxPanel.ts is the page's, inboxview.rs what they say).
// The Inbox is a panel in the dock's notch, which places it and gives it the keyboard
// (dockkeys.rs); this keeps whether it is open and talks to Hearth's desk through desk.rs, which
// holds the desk's secret: the page never sees it. Windows Hello's prompt takes the keyboard
// while it opens the desk; that doesn't close the Inbox, and the notch takes the keyboard back
// once the prompt is gone. Opening a card in Hearth's window closes the Inbox without handing the
// keyboard back, as Hearth's window comes to the front.

use super::dock::DOCK_LABEL;
use super::dockkeys;
use super::host::Shared;
use super::inboxview::{cards, InboxAct, InboxCard, InboxPhase, InboxTrouble, InboxView};
use crate::hearth::desk::{self, DeskError};
use crate::hearth::{links, window};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

pub const INBOX_EVENT: &str = "nook://inbox";

struct InboxRun {
    seq: u32,
    open: bool,
    phase: InboxPhase,
    cards: Vec<InboxCard>,
    total: u32,
    trouble: Option<InboxTrouble>,
    /// Windows Hello is up, and has the keyboard.
    unlocking: bool,
}

static RUN: Mutex<InboxRun> = Mutex::new(InboxRun {
    seq: 0,
    open: false,
    phase: InboxPhase::Shut,
    cards: Vec::new(),
    total: 0,
    trouble: None,
    unlocking: false,
});

fn run() -> MutexGuard<'static, InboxRun> {
    RUN.lock().unwrap_or_else(|e| e.into_inner())
}

/// The desk action an act asks for, with its input; None for the Inbox's own acts.
pub fn desk_call(act: &InboxAct) -> Option<(&'static str, Value)> {
    Some(match act {
        InboxAct::Decide { approval_id, yes } => {
            let decision = if *yes { "approve" } else { "deny" };
            (
                "desk.decide",
                json!({ "approvalId": approval_id, "decision": decision }),
            )
        }
        InboxAct::Answer {
            question_id,
            choice,
            text,
        } => {
            let mut input = json!({ "questionId": question_id });
            if let Some(c) = choice {
                input["choice"] = json!(c);
            }
            if let Some(t) = text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                input["text"] = json!(t.chars().take(2000).collect::<String>());
            }
            ("desk.answer", input)
        }
        InboxAct::Reply { id, choice } => ("desk.reply", json!({ "id": id, "choice": choice })),
        InboxAct::Clear { id } => ("desk.mark", json!({ "id": id, "state": "done" })),
        InboxAct::Seen { id } => ("desk.mark", json!({ "id": id, "state": "seen" })),
        _ => return None,
    })
}

/// Where a refusal leaves the Inbox: the phase, what to say, and Hearth's own words for an act.
pub fn after(e: &DeskError) -> (InboxPhase, Option<InboxTrouble>, Option<String>) {
    let trouble = Some(InboxTrouble {
        word: e.word().into(),
        says: e.says(),
    });
    match e {
        DeskError::Shut => (InboxPhase::Shut, None, None),
        DeskError::HelloClosed | DeskError::HelloLocked => (InboxPhase::Shut, trouble, None),
        DeskError::Refused { message, .. } => (InboxPhase::Open, None, Some(message.clone())),
        _ => (InboxPhase::Trouble, trouble, None),
    }
}

/// The view as things stand, numbered.
fn view(refused: Option<String>) -> InboxView {
    let mut r = run();
    r.seq += 1;
    InboxView {
        seq: r.seq,
        open: r.open,
        phase: r.phase,
        cards: r.cards.clone(),
        total: r.total,
        trouble: r.trouble.clone(),
        refused,
    }
}

fn emit(shared: &Shared, v: &InboxView) {
    let _ = shared.app.emit_to(DOCK_LABEL, INBOX_EVENT, v);
}

/// Whether Windows Hello's prompt is up for the Inbox, so the notch losing the keyboard to it
/// closes nothing (dockkeys.rs).
pub fn unlocking() -> bool {
    run().unlocking
}

/// Closes the Inbox from Nook's side, as a card opens in Hearth's window: the notch lets the
/// keyboard go without handing it back, and the page hears the Inbox closed.
fn close(shared: &Arc<Shared>) {
    run().open = false;
    dockkeys::release(shared, false);
}

/// Lists the desk, when it is open here.
async fn list(shared: &Arc<Shared>, refused: Option<String>) -> InboxView {
    if !desk::is_open() {
        let mut r = run();
        r.phase = InboxPhase::Shut;
        r.cards.clear();
        drop(r);
        return view(refused);
    }
    match desk::act(&shared.app, "desk.list", json!({})).await {
        Ok(result) => {
            let (all, total) = cards(&result);
            let mut r = run();
            (r.phase, r.cards, r.total, r.trouble) = (InboxPhase::Open, all, total, None);
        }
        Err(e) => {
            let (phase, trouble, _) = after(&e);
            let mut r = run();
            (r.phase, r.trouble) = (phase, trouble);
            if phase != InboxPhase::Open {
                r.cards.clear();
            }
        }
    }
    view(refused)
}

async fn unlock(shared: &Arc<Shared>) -> InboxView {
    {
        let mut r = run();
        (r.phase, r.trouble, r.unlocking) = (InboxPhase::Opening, None, true);
    }
    emit(shared, &view(None));
    let opened = desk::unlock(&shared.app).await;
    let still = {
        let mut r = run();
        r.unlocking = false;
        r.open
    };
    // Windows Hello's prompt had the keyboard: the notch takes it back for the Inbox.
    if still {
        dockkeys::retake(shared);
    }
    let Err(e) = opened else {
        return list(shared, None).await;
    };
    let (phase, trouble, _) = after(&e);
    {
        let mut r = run();
        r.phase = phase;
        // Hearth's own words for why it didn't open (it isn't reached on this PC, say).
        r.trouble = trouble.or(Some(InboxTrouble {
            word: e.word().into(),
            says: e.says(),
        }));
        if phase == InboxPhase::Open {
            r.phase = InboxPhase::Trouble;
        }
    }
    view(None)
}

/// What the page's act does, and the view after it.
pub async fn act(shared: &Arc<Shared>, act: InboxAct) -> InboxView {
    if let Some((name, input)) = desk_call(&act) {
        let seen = matches!(act, InboxAct::Seen { .. });
        return match desk::act(&shared.app, name, input).await {
            Ok(_) if seen => view(None),
            Ok(_) => list(shared, None).await,
            Err(e) => {
                let (phase, trouble, refused) = after(&e);
                if phase != InboxPhase::Open {
                    let mut r = run();
                    (r.phase, r.trouble) = (phase, trouble);
                    r.cards.clear();
                }
                list(shared, refused.filter(|_| !seen)).await
            }
        };
    }
    match act {
        InboxAct::Open => {
            // Whatever the notch's hover: a notice opens the Inbox with the notch folded.
            run().open = true;
            list(shared, None).await
        }
        InboxAct::Close => {
            run().open = false;
            view(None)
        }
        InboxAct::Unlock => {
            let busy = run().unlocking;
            if busy {
                return view(None);
            }
            unlock(shared).await
        }
        InboxAct::Show { url } => {
            match links::relative_path(&url) {
                Ok(path) => {
                    close(shared);
                    window::open(&shared.app, &path);
                }
                Err(e) => log::warn!("The Inbox's card doesn't open in Hearth: {e}"),
            }
            view(None)
        }
        InboxAct::Today => {
            close(shared);
            window::open(&shared.app, "/today");
            view(None)
        }
        _ => view(None),
    }
}

/// The notch let the keyboard go with the Inbox open (dockkeys.rs): it closes, and the page hears.
pub fn let_go(shared: &Shared) {
    let was = std::mem::replace(&mut run().open, false);
    if was {
        emit(shared, &view(None));
    }
}

/// Hearth sent this PC a notification: an open Inbox lists the desk again.
pub fn arrived(app: &AppHandle) {
    let open = {
        let r = run();
        r.open && r.phase == InboxPhase::Open
    };
    let Some(shared) = super::host::shared(app).filter(|_| open) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let v = list(&shared, None).await;
        emit(&shared, &v);
    });
}

#[cfg(test)]
#[path = "dockinbox_tests.rs"]
mod tests;
