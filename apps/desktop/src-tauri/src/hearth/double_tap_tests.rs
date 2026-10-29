use super::*;
use handy_keys::Key;

const MS: fn(u64) -> Duration = Duration::from_millis;
const NONE: [(Tap, u64); 0] = [];

/// Feeds `steps` (what, at how many ms) to a fresh Taps, ticking at each step as the thread does
/// when nothing comes, and gives back every tap it adds up to, with when.
fn run(steps: &[(Input, u64)]) -> Vec<(Tap, u64)> {
    let t0 = Instant::now();
    let mut taps = Taps::default();
    let mut out = Vec::new();
    let mut at = 0;
    for &(input, ms) in steps {
        // Time passes in 5 ms ticks up to the next key.
        while at + 5 < ms {
            at += 5;
            if let Some(t) = taps.tick(t0 + MS(at)) {
                out.push((t, at));
            }
        }
        at = ms;
        if let Some(t) = taps.feed(input, t0 + MS(ms)) {
            out.push((t, ms));
        }
    }
    out
}

use Input::{Alt as A, CtrlDown as D, CtrlUp as U, Other as O};

#[test]
fn two_quick_taps_open_the_box_when_the_second_lets_go() {
    assert_eq!(
        run(&[(D, 0), (U, 90), (D, 200), (U, 280)]),
        [(Tap::Double, 280)]
    );
    // A slow pair still counts while the second press comes within the window.
    assert_eq!(
        run(&[(D, 0), (U, 240), (D, 440), (U, 520)]),
        [(Tap::Double, 520)]
    );
    // Each press may last a tap's length, and no more.
    assert_eq!(
        run(&[(D, 0), (U, 250), (D, 300), (U, 550)]),
        [(Tap::Double, 550)]
    );
    // Three taps are one double-tap and a first tap; four are two.
    let four = [
        (D, 0),
        (U, 60),
        (D, 120),
        (U, 180),
        (D, 700),
        (U, 760),
        (D, 820),
        (U, 880),
    ];
    assert_eq!(run(&four), [(Tap::Double, 180), (Tap::Double, 880)]);
}

#[test]
fn a_second_press_after_the_window_starts_over() {
    assert_eq!(run(&[(D, 0), (U, 100), (D, 450), (U, 500)]), NONE);
    // ...and is a first tap of its own.
    assert_eq!(
        run(&[(D, 0), (U, 100), (D, 600), (U, 650), (D, 800), (U, 850)]),
        [(Tap::Double, 850)]
    );
    // A first press held past the window is no tap.
    assert_eq!(run(&[(D, 0), (U, 460), (D, 520), (U, 560)]), NONE);
}

#[test]
fn ctrl_held_to_zoom_or_hover_is_no_tap() {
    // The listener never hears the wheel: Ctrl held a while, twice, is zooming, not tapping.
    assert_eq!(run(&[(D, 0), (U, 300), (D, 380), (U, 440)]), NONE);
    // A longer first press voids the pair, however short the second.
    assert_eq!(run(&[(D, 0), (U, 260), (D, 330), (U, 380)]), NONE);
    // A second press too long for a tap and too short for a hold is neither.
    assert_eq!(run(&[(D, 0), (U, 80), (D, 150), (U, 450)]), NONE);
}

#[test]
fn anything_else_in_between_cancels_it() {
    // A key between the taps.
    assert_eq!(run(&[(D, 0), (U, 80), (O, 120), (D, 200), (U, 260)]), NONE);
    // Ctrl+C on the second press, and on the first: Ctrl held for a shortcut never counts.
    assert_eq!(
        run(&[(D, 0), (U, 80), (D, 150), (O, 180), (O, 220), (U, 260)]),
        NONE
    );
    assert_eq!(
        run(&[(D, 0), (O, 40), (O, 70), (U, 90), (D, 150), (U, 210)]),
        NONE
    );
    // A key let go in the gap counts as much as one pressed.
    assert_eq!(
        run(&[(O, 0), (D, 10), (U, 60), (O, 100), (D, 150), (U, 200)]),
        NONE
    );
}

#[test]
fn auto_repeat_is_no_new_press() {
    // Windows repeats a held key's down: none of these are presses of their own.
    let repeats = [
        (D, 0),
        (D, 30),
        (D, 60),
        (U, 90),
        (D, 200),
        (D, 230),
        (U, 260),
    ];
    assert_eq!(run(&repeats), [(Tap::Double, 260)]);
    // A stray up with nothing down changes nothing.
    assert_eq!(
        run(&[(U, 0), (D, 50), (U, 100), (D, 200), (U, 250)]),
        [(Tap::Double, 250)]
    );
}

#[test]
fn held_on_the_second_press_it_listens_until_let_go() {
    assert_eq!(
        run(&[(D, 0), (U, 80), (D, 150), (U, 1200)]),
        [(Tap::Hold, 150 + 350), (Tap::HoldEnd, 1200)]
    );
    // Another key while held throws it away, and Ctrl's release after that is nothing.
    assert_eq!(
        run(&[(D, 0), (U, 80), (D, 150), (O, 900), (U, 1000)]),
        [(Tap::Hold, 500), (Tap::HoldCancel, 900)]
    );
    // A first press held is no hold: only a second press is.
    assert_eq!(run(&[(D, 0), (U, 2000)]), NONE);
}

#[test]
fn alt_alone_while_held_is_tao_taking_the_foreground() {
    // tao presses and lets go of Alt when Windows won't hand the box the foreground.
    assert_eq!(
        run(&[(D, 0), (U, 80), (D, 150), (A, 1500), (A, 1500), (U, 2000)]),
        [(Tap::Hold, 500), (Tap::HoldEnd, 2000)]
    );
    // Alt and a key, as Alt+Tab, is the owner's: thrown away.
    assert_eq!(
        run(&[(D, 0), (U, 80), (D, 150), (A, 900), (O, 950), (A, 1000)]),
        [(Tap::Hold, 500), (Tap::HoldCancel, 950)]
    );
    // Between the taps Alt starts over, as any other key.
    assert_eq!(run(&[(D, 0), (U, 80), (A, 100), (D, 150), (U, 200)]), NONE);
}

#[test]
fn a_release_lost_while_held_is_read_from_the_keyboard() {
    let t0 = Instant::now();
    let mut taps = Taps::default();
    assert_eq!(taps.read_ctrl(false, t0), None, "nothing held");
    taps.feed(D, t0);
    taps.feed(U, t0 + MS(80));
    taps.feed(D, t0 + MS(150));
    assert_eq!(taps.read_ctrl(false, t0 + MS(200)), None, "not held yet");
    assert_eq!(taps.tick(t0 + MS(500)), Some(Tap::Hold));
    assert!(taps.held());
    assert_eq!(taps.read_ctrl(true, t0 + MS(600)), None, "still down");
    // Up, as Windows reads it, though no release came: the hold ends as letting go would.
    assert_eq!(taps.read_ctrl(false, t0 + MS(700)), Some(Tap::HoldEnd));
    assert!(!taps.held());
    // The release that comes late changes nothing; the next double-tap counts.
    assert_eq!(taps.feed(U, t0 + MS(900)), None);
    for (input, ms) in [(D, 1000), (U, 1050), (D, 1100)] {
        assert_eq!(taps.feed(input, t0 + MS(ms)), None);
    }
    assert_eq!(taps.feed(U, t0 + MS(1150)), Some(Tap::Double));
}

fn ctrl(down: bool, modifiers: Modifiers, changed: Modifiers) -> KeyEvent {
    KeyEvent {
        modifiers,
        key: None,
        is_key_down: down,
        changed_modifier: Some(changed),
    }
}

#[test]
fn either_ctrl_counts_and_nothing_else_does() {
    let left = Modifiers::CTRL_LEFT;
    let right = Modifiers::CTRL_RIGHT;
    assert_eq!(input_of(&ctrl(true, left, left)), Some(D));
    assert_eq!(input_of(&ctrl(false, Modifiers::empty(), left)), Some(U));
    assert_eq!(input_of(&ctrl(true, right, right)), Some(D));
    // A single Ctrl let go while the other is held: still down.
    assert_eq!(input_of(&ctrl(false, left, right)), None);
    // The last Ctrl let go while Shift is still held: Ctrl is up.
    assert_eq!(input_of(&ctrl(false, Modifiers::SHIFT, left)), Some(U));
    // Ctrl with Shift held, and Shift itself, are something else.
    assert_eq!(
        input_of(&ctrl(true, left | Modifiers::SHIFT, left)),
        Some(O)
    );
    let shift = Modifiers::SHIFT;
    assert_eq!(input_of(&ctrl(true, shift, shift)), Some(O));
    assert_eq!(input_of(&ctrl(false, Modifiers::empty(), shift)), Some(O));
    // Alt alone, going down or up beside Ctrl, is Alt; with Shift held it is something else.
    let alt = Modifiers::OPT_LEFT;
    assert_eq!(input_of(&ctrl(true, left | alt, alt)), Some(A));
    assert_eq!(input_of(&ctrl(false, left, alt)), Some(A));
    assert_eq!(input_of(&ctrl(true, left | alt | shift, alt)), Some(O));
    // Any key or mouse button, down or up.
    for (key, down) in [(Key::C, true), (Key::C, false), (Key::MouseMiddle, true)] {
        let e = KeyEvent {
            modifiers: left,
            key: Some(key),
            is_key_down: down,
            changed_modifier: None,
        };
        assert_eq!(input_of(&e), Some(O));
    }
}
