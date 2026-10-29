// Double-tap Ctrl opens the quick-ask box (decision L2-17), as its shortcut does and through the
// same door: quick_ask.rs's game guard and its reading of the window in front. Two presses and
// releases of Ctrl, either one, count when the second press comes within WINDOW of the first
// (as measured on the reference) and each press is let go within TAP_MOST. Anything else pressed
// in between, a key, another modifier or a mouse button, starts over, so Ctrl+C and the like
// never count, and a key's auto-repeat is no new press. The listener never hears the wheel or the
// pointer moving, so Ctrl held to zoom with the wheel, or while hovering, is ruled out by how long
// it is held. Held down on the second press for HOLD_AFTER, Ctrl opens the box listening, and
// letting go stops it (quick_ask_talk.rs); another key while it is held throws that recording
// away. Alt alone isn't such a key while it is held: when Windows won't hand the box the
// foreground, tao presses and lets go of Alt to take it. A release lost to the secure desktop
// (UAC) is caught by reading Ctrl every READ_EVERY while it holds the box listening.
//
// Taps decides this from what it is fed and when, so it is tested without a keyboard. The thread
// below feeds it from handy-keys' low-level listener, the kind Handy's own shortcuts use, only on
// Windows, where the box opens, and only while its setting (hearth_ask_double_tap) is on, as it
// is unless turned off. Its events carry no time of their own, so each is timed as it arrives.
// That listener tells left and right clicks only while a modifier is down: a click while Ctrl is
// down starts over, one in the gap between the taps goes unseen.

use crate::settings::{get_settings, write_settings};
use handy_keys::{KeyEvent, Modifiers};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// The most from the first press to the second, as measured on the reference.
pub const WINDOW: Duration = Duration::from_millis(450);
/// The longest a press lasts to be a tap, from down to up.
pub const TAP_MOST: Duration = Duration::from_millis(250);
/// The second press held this long is a hold, not a tap.
pub const HOLD_AFTER: Duration = Duration::from_millis(350);
/// How often the listener's thread looks at the time while no key comes.
const POLL: Duration = Duration::from_millis(15);
/// How often Ctrl is read while it holds the box listening, in case its release was lost.
const READ_EVERY: Duration = Duration::from_millis(100);

/// What the keyboard did, as the double-tap sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    /// Ctrl went down, with nothing else held.
    CtrlDown,
    /// The last Ctrl held went up.
    CtrlUp,
    /// Alt alone went down or up, with nothing but Ctrl held.
    Alt,
    /// Any other key, modifier or mouse button, down or up.
    Other,
}

/// What it adds up to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tap {
    /// Two quick taps: the box opens.
    Double,
    /// Ctrl held down on the second press: the box opens listening.
    Hold,
    /// Let go after a Hold: what was said goes into the box.
    HoldEnd,
    /// Another key while held: what was said is thrown away.
    HoldCancel,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Idle,
    /// The first press, down since `at`.
    First { at: Instant },
    /// The first tap is over; it began at `first`.
    Gap { first: Instant },
    /// The second press, down since `at`.
    Second { at: Instant },
    /// The second press became a hold.
    Held,
}

/// The double-tap, fed what the keyboard does and the time it did it.
#[derive(Debug, Default)]
pub struct Taps {
    state: State,
    /// Whether Ctrl is down now.
    down: bool,
}

impl Taps {
    pub fn feed(&mut self, input: Input, now: Instant) -> Option<Tap> {
        let (state, tap) = match (input, self.state) {
            // Auto-repeat, or the other Ctrl while one is down: no new press.
            (Input::CtrlDown, _) if self.down => return None,
            (Input::CtrlUp, _) if !self.down => return None,
            // tao's Alt, taking the foreground for the box.
            (Input::Alt, State::Held) => return None,
            (Input::CtrlDown, State::Gap { first }) if now.duration_since(first) < WINDOW => {
                (State::Second { at: now }, None)
            }
            (Input::CtrlDown, _) => (State::First { at: now }, None),
            (Input::CtrlUp, State::First { at }) if now.duration_since(at) <= TAP_MOST => {
                (State::Gap { first: at }, None)
            }
            (Input::CtrlUp, State::Second { at }) if now.duration_since(at) <= TAP_MOST => {
                (State::Idle, Some(Tap::Double))
            }
            (Input::CtrlUp, State::Held) => (State::Idle, Some(Tap::HoldEnd)),
            (Input::CtrlUp, _) => (State::Idle, None),
            (Input::Other, State::Held) => (State::Idle, Some(Tap::HoldCancel)),
            (Input::Alt | Input::Other, _) => (State::Idle, None),
        };
        match input {
            Input::CtrlDown => self.down = true,
            Input::CtrlUp => self.down = false,
            Input::Alt | Input::Other => {}
        }
        self.state = state;
        tap
    }

    /// Time passing with no key: the second press held long enough is a hold, and a first tap
    /// with no second in time is forgotten.
    pub fn tick(&mut self, now: Instant) -> Option<Tap> {
        match self.state {
            State::Second { at } if now.duration_since(at) >= HOLD_AFTER => {
                self.state = State::Held;
                Some(Tap::Hold)
            }
            State::Gap { first } if now.duration_since(first) >= WINDOW => {
                self.state = State::Idle;
                None
            }
            _ => None,
        }
    }

    /// Ctrl as Windows reads it now (`down`), every READ_EVERY while it holds the box listening:
    /// read up, its release was lost, and the hold ends as letting go would end it.
    pub fn read_ctrl(&mut self, down: bool, now: Instant) -> Option<Tap> {
        if self.state != State::Held || down {
            return None;
        }
        self.feed(Input::CtrlUp, now)
    }

    /// Whether Ctrl holds the box listening.
    pub fn held(&self) -> bool {
        self.state == State::Held
    }
}

/// A handy-keys event as the double-tap sees it; None when one Ctrl goes up while the other
/// stays down.
pub fn input_of(e: &KeyEvent) -> Option<Input> {
    let Some(changed) = e.changed_modifier.filter(|_| e.key.is_none()) else {
        return Some(Input::Other);
    };
    let ctrl_alt = Modifiers::CTRL | Modifiers::OPT;
    if Modifiers::OPT.contains(changed) && ctrl_alt.contains(e.modifiers) {
        return Some(Input::Alt);
    }
    if !Modifiers::CTRL.contains(changed) {
        return Some(Input::Other);
    }
    let bare = e.modifiers.difference(Modifiers::CTRL).is_empty();
    match (e.is_key_down, e.modifiers.intersects(Modifiers::CTRL)) {
        // Ctrl with another modifier held starts a shortcut.
        (true, _) if !bare => Some(Input::Other),
        (true, _) => Some(Input::CtrlDown),
        // The last Ctrl let go is Ctrl up, whatever else is still held.
        (false, false) => Some(Input::CtrlUp),
        (false, true) => None,
    }
}

/// Set while the listener's thread runs; setting the flag stops it.
static RUNNING: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

/// Starts or stops listening for the double-tap, as its setting says.
pub fn sync(app: &AppHandle) {
    let on = cfg!(windows) && get_settings(app).hearth_ask_double_tap;
    let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    match (on, running.take()) {
        (true, None) => {
            let stop = Arc::new(AtomicBool::new(false));
            let (app, flag) = (app.clone(), stop.clone());
            let spawned = std::thread::Builder::new()
                .name("hearth-double-tap".into())
                .spawn(move || listen(&app, &flag));
            match spawned {
                Ok(_) => *running = Some(stop),
                Err(e) => log::warn!("Double-tap Ctrl is off: no thread for it ({e})"),
            }
        }
        (false, Some(stop)) => stop.store(true, Ordering::SeqCst),
        (_, kept) => *running = kept,
    }
}

fn listen(app: &AppHandle, stop: &Arc<AtomicBool>) {
    match handy_keys::KeyboardListener::new() {
        Ok(keys) => watch(app, &keys, stop),
        Err(e) => log::warn!("Double-tap Ctrl is off: no keyboard listener ({e})"),
    }
    let mut running = RUNNING.lock().unwrap_or_else(|p| p.into_inner());
    if running.as_ref().is_some_and(|s| Arc::ptr_eq(s, stop)) {
        *running = None;
    }
}

fn watch(app: &AppHandle, keys: &handy_keys::KeyboardListener, stop: &AtomicBool) {
    let mut taps = Taps::default();
    let mut read_at = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        let got = keys.recv_timeout(POLL);
        let now = Instant::now();
        let tap = match got {
            Ok(e) => input_of(&e).and_then(|i| taps.feed(i, now)),
            Err(handy_keys::Error::Timeout) => None,
            Err(e) => {
                log::warn!("Double-tap Ctrl stopped: {e}");
                return;
            }
        };
        let mut tap = tap.or_else(|| taps.tick(now));
        if tap.is_none() && taps.held() && now.duration_since(read_at) >= READ_EVERY {
            read_at = now;
            tap = taps.read_ctrl(ctrl_down(), now);
        }
        match tap {
            Some(Tap::Double) => super::quick_ask::open_by_tap(app, false),
            Some(Tap::Hold) => super::quick_ask::open_by_tap(app, true),
            Some(Tap::HoldEnd) => super::quick_ask_talk::let_go(app, true),
            Some(Tap::HoldCancel) => super::quick_ask_talk::let_go(app, false),
            None => {}
        }
    }
}

/// Whether either Ctrl is down now, as Windows reads the keyboard; false while the secure
/// desktop has it.
#[cfg(windows)]
fn ctrl_down() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_CONTROL};
    // The high bit, read as a negative number, says the key is down now.
    unsafe { GetAsyncKeyState(i32::from(VK_CONTROL.0)) < 0 }
}

#[cfg(not(windows))]
fn ctrl_down() -> bool {
    true
}

/// The setting: double-tap Ctrl to open Ask Pip, on unless turned off.
#[tauri::command]
#[specta::specta]
pub fn change_hearth_ask_double_tap_setting(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = get_settings(&app);
    s.hearth_ask_double_tap = enabled;
    write_settings(&app, s);
    sync(&app);
    Ok(())
}

#[cfg(test)]
#[path = "double_tap_tests.rs"]
mod tests;
