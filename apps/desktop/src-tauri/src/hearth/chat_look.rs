// The notch's chat with Pip (chat.rs): what it reads from Hearth. The switcher's list, a page of
// the conversation shown, looking for Pip's words while it works, and noticing the desk shut while
// the panel is open.
//
// Looking asks once a second for what came after the newest line, through the desk while it's
// open, else with the token. It stops when Pip is done and its ready replies have had time to
// come, and on its own (Looking, chat_parts.rs) after five failed looks in a row or five minutes
// of Pip seeming at work with no new line: every look at the desk counts as using it, so a stuck
// turn mustn't keep the desk open to its 8-hour cap. A send, a switch or opening the panel again
// starts it afresh.

use super::parts::{items_of, Looking, Next, Page};
use super::state::ChatRun;
use super::{answer, run, trouble, view, EVERY, NOT_PAIRED, WAIT};
use crate::hearth::desk::{self, DeskError};
use crate::hearth::quick_ask_parts::conversation_gone;
use serde_json::json;
use std::time::Instant;
use tauri::AppHandle;

/// The desk's recent conversations, for the switcher.
pub(super) async fn list(app: &AppHandle) {
    if !desk::is_open() {
        return;
    }
    match desk::act(app, "desk.conversation", json!({})).await {
        Ok(result) => run().recent = items_of(&result),
        Err(e) => run().trouble = trouble(&e),
    }
}

/// Reads the conversation shown: its newest page, a page further back, or what came after the
/// newest entry read. Through the desk while it's open, else with the token. Whether Hearth
/// answered: false when it failed, or refused the token this conversation.
pub(super) async fn load(app: &AppHandle, how: Page) -> bool {
    let (id, ver, last, first, via_desk) = {
        let r = run();
        let first = r.lines.first().map_or(i64::MAX, |l| l.idx);
        (r.conversation.clone(), r.ver, r.last, first, r.via_desk)
    };
    let Some(id) = id else {
        return true;
    };
    let current = |r: &ChatRun| r.ver == ver;
    if desk::is_open() {
        // Read the other way last time: the paging starts again from the newest page.
        let how = if via_desk { how } else { Page::Newest };
        let mut input = json!({ "id": id });
        match how {
            Page::Newest => {}
            Page::Older => input["before"] = json!(first),
            Page::After => input["after"] = json!(last),
        }
        match desk::act(app, "desk.conversation", input).await {
            Ok(result) => {
                let mut r = run();
                if current(&r) {
                    r.took_page(&result, how);
                    r.trouble = None;
                    r.remember();
                }
                return true;
            }
            // The desk shut meanwhile: the token's reach, below.
            Err(DeskError::Shut) => {}
            Err(e) => {
                let mut r = run();
                if current(&r) {
                    r.trouble = trouble(&e);
                }
                return false;
            }
        }
    }
    if how == Page::Older && !via_desk {
        run().older_from_held();
        return true;
    }
    let Some(h) = crate::hearth::link(app) else {
        run().trouble = Some(NOT_PAIRED.into());
        return false;
    };
    let whole = how != Page::After || via_desk;
    let mut input = json!({ "id": id });
    if !whole {
        input["afterIdx"] = json!(last);
    }
    let got = h.call("conversation.get", input, WAIT).await;
    let mut r = run();
    if !current(&r) {
        return true;
    }
    match got {
        Ok(result) => {
            r.took_log(&result, whole);
            r.trouble = None;
            r.remember();
            true
        }
        // Not the app's own (D42), or gone: either way only the desk can say more.
        Err(e) if conversation_gone(&e) => {
            r.refuse();
            false
        }
        Err(e) => {
            r.trouble = Some(e);
            false
        }
    }
}

/// Looks for Pip's words once a second while the panel is open and Pip works. Only the latest
/// looking goes on: opening, switching or closing the panel moves `poll` on.
pub(super) fn keep_looking(app: &AppHandle) {
    let (gen, newest) = {
        let mut r = run();
        r.poll += 1;
        (r.poll, r.last)
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let looking = |gen: u64| {
            let r = run();
            r.open && r.poll == gen
        };
        let mut look = Looking::new(newest, Instant::now());
        loop {
            tokio::time::sleep(EVERY).await;
            if !looking(gen) {
                return;
            }
            let read = load(&app, Page::After).await;
            if !looking(gen) {
                return;
            }
            let now = Instant::now();
            let (newest, working) = {
                let r = run();
                (r.last, r.working(now))
            };
            let next = look.after(read, newest, working, now);
            if next == Next::GiveUp {
                run().give_up();
            }
            view(&app, true);
            if next != Next::Again {
                return;
            }
        }
    });
}

/// While the panel is open, notices the desk shutting (Windows locked, the PC slept) and shows
/// the locked view at once, not at the next thing you do; and the desk opening from elsewhere,
/// like the Inbox's Unlock. It reads only the desk's own flag here, which costs nothing and
/// never counts as using the desk.
pub(super) fn watch_desk(app: &AppHandle) {
    let gen = {
        let mut r = run();
        r.watch += 1;
        r.watch
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut was = desk::is_open();
        loop {
            tokio::time::sleep(EVERY).await;
            {
                let r = run();
                if !r.open || r.watch != gen {
                    return;
                }
            }
            let open = desk::is_open();
            if open == was {
                continue;
            }
            was = open;
            if open {
                // Now any conversation shows: the one on screen and the desk's list, read again.
                list(&app).await;
                load(&app, Page::Newest).await;
                answer(&app);
            } else {
                view(&app, true);
            }
        }
    });
}
