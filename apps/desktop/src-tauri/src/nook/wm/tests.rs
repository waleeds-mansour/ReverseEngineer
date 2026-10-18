// nook-wm's state from scripted batches and the tests' probe: no hook, no window, no Win32 write.

use super::fixtures;
use super::state::{Wm, KEEP_CLOSED};
use super::views;
use crate::nook::bar::BarRun;
use crate::nook::coalesce::{bit, global, Batch, Delta};
use crate::nook::fake::{app_window, process, two_monitors, FakeProbe};
use crate::nook::gates::{MISSING_FOR, SETTLE};
use crate::nook::probe::{Hwnd, Own};
use crate::nook::shell::Signal;
use crate::nook::view::{VerdictName, WindowState};
use std::time::{Duration, Instant};

const CHROME: &str = r"C:\Program Files\Google\Chrome\Application\chrome.exe";

fn probe_with(n: usize) -> FakeProbe {
    let mut p = FakeProbe::default();
    *p.screens.borrow_mut() = two_monitors();
    for i in 0..n {
        let pid = 100 + i as u32;
        p.add(i as Hwnd + 1, app_window("Chrome_WidgetWin_1", pid))
            .proc(pid, Ok(process(CHROME)));
    }
    p.descriptions.insert(CHROME.into(), "Google Chrome".into());
    p
}

fn wm(probe: FakeProbe, dir: &std::path::Path) -> Wm<FakeProbe> {
    Wm::new(
        probe,
        Own {
            pid: 1,
            elevated: false,
        },
        dir.to_path_buf(),
        Instant::now(),
    )
}

fn shown(h: Hwnd) -> (Hwnd, Delta) {
    (
        h,
        Delta {
            bits: bit::SHOWN,
            last_ms: 1,
        },
    )
}

#[test]
fn alt_tab_between_known_windows_opens_no_process() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = wm(probe_with(3), tmp.path());
    let t = Instant::now();
    for h in [1, 2, 3, 1, 2, 3, 1] {
        w.apply(
            &Batch {
                foreground: Some(h),
                ..Batch::default()
            },
            t,
        );
    }
    assert_eq!(w.probe.opens(), 3, "one open per window, the first time");
    let state = views::state(&w, t, 1);
    let focused = state.focused.unwrap();
    assert_eq!(
        (focused.app.as_str(), focused.verdict),
        ("Google Chrome", VerdictName::Tile)
    );
    assert!(state.windows.is_empty(), "the list is for the panel only");
    assert_eq!(state.writes.attempted, 0);
}

#[test]
fn with_the_panel_closed_only_recently_focused_windows_are_kept() {
    let tmp = tempfile::tempdir().unwrap();
    let n = KEEP_CLOSED + 10;
    let mut w = wm(probe_with(n), tmp.path());
    let t = Instant::now();
    w.set_panel(true);
    assert_eq!(w.windows.len(), n);
    assert_eq!(views::state(&w, t, 1).windows.len(), n);
    w.apply(
        &Batch {
            foreground: Some(5),
            ..Batch::default()
        },
        t,
    );
    w.set_panel(false);
    assert_eq!(w.windows.keys().copied().collect::<Vec<_>>(), vec![5]);
    let (_, removed) = w.take_known();
    assert_eq!(removed.len(), n - 1, "the callback forgets them too");
}

#[test]
fn a_destroyed_window_leaves_and_a_new_one_is_judged_once() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = wm(probe_with(2), tmp.path());
    w.set_panel(true);
    let t = Instant::now();
    let opens = w.probe.opens();
    w.apply(
        &Batch {
            windows: vec![(
                1,
                Delta {
                    bits: bit::DESTROYED | bit::SHOWN,
                    last_ms: 1,
                },
            )],
            ..Batch::default()
        },
        t,
    );
    assert!(!w.windows.contains_key(&1), "destroy wins over everything");
    assert_eq!(w.probe.opens(), opens);
    w.apply(
        &Batch {
            windows: vec![shown(2)],
            ..Batch::default()
        },
        t,
    );
    assert_eq!(
        w.probe.opens(),
        opens + 1,
        "shown again: judged from Stage A"
    );
}

#[test]
fn a_fullscreen_window_in_front_trips_the_game_guard_and_leaving_clears_it() {
    let tmp = tempfile::tempdir().unwrap();
    let mut p = probe_with(2);
    let video = p.windows.get_mut(&2).unwrap();
    video.facts.rect = two_monitors()[0].rect;
    video.facts.style = 0x1600_0000;
    let mut w = wm(p, tmp.path());
    let t = Instant::now();
    let front = |h| Batch {
        foreground: Some(h),
        ..Batch::default()
    };
    w.apply(&front(2), t);
    assert!(w.gates.game_guard);
    let state = views::state(&w, t, 1);
    assert!(state.focused.unwrap().game);
    assert_eq!(state.gates[0].name, "game_guard");
    w.apply(&front(1), t + Duration::from_secs(1));
    assert!(!w.gates.game_guard);
    assert_eq!(
        w.stats.passes_observed, 1,
        "a pass would run, and is only counted"
    );
    let log = std::fs::read_to_string(tmp.path().join(nook_restore::log::FILE_NAME)).unwrap();
    assert!(log.contains("gate game_guard on") && log.contains("gate game_guard off"));
}

#[test]
fn a_display_change_settles_then_counts_one_pass() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = wm(probe_with(1), tmp.path());
    let t = Instant::now();
    w.shell(Signal::DisplayChange, t);
    assert_eq!(w.due(), Some(t + SETTLE));
    w.tick(t + Duration::from_secs(1));
    assert_eq!(w.stats.passes_observed, 0);
    w.tick(t + SETTLE);
    assert_eq!(w.stats.passes_observed, 1);
    assert_eq!(w.due(), None, "nothing left to wake for");
}

#[test]
fn a_monitor_that_stays_away_is_let_go_after_thirty_seconds() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = wm(probe_with(1), tmp.path());
    let t = Instant::now();
    assert_eq!(w.watched, vec![two_monitors()[0].id.clone()]);
    w.probe.screens.borrow_mut().remove(0);
    w.shell(Signal::DisplayChange, t);
    w.tick(t + SETTLE);
    assert!(w.gates.display_missing_since.is_some());
    assert_eq!(w.due(), Some(t + SETTLE + MISSING_FOR));
    w.tick(t + SETTLE + MISSING_FOR);
    assert!(w.watched.is_empty());
    assert_eq!(w.stats.put_backs, 1);
    *w.probe.screens.borrow_mut() = two_monitors();
    w.shell(Signal::DisplayChange, t + Duration::from_secs(40));
    w.tick(t + Duration::from_secs(43));
    let state = views::state(&w, t + Duration::from_secs(43), 1);
    assert!(
        !state.monitors[0].managed,
        "not arranged again until observing restarts"
    );
    // The bar comes back with the monitor at settle end all the same.
    let mut bar = BarRun {
        made: true,
        bar_drawn: true,
        ..BarRun::default()
    };
    bar.take(&state);
    assert_eq!(bar.monitor.map(|m| m.rect), Some(two_monitors()[0].rect));
    assert!(bar.bar_visible());
}

#[test]
fn going_fullscreen_in_place_trips_the_game_guard_without_a_focus_change() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = wm(probe_with(1), tmp.path());
    let t = Instant::now();
    w.apply(
        &Batch {
            foreground: Some(1),
            ..Batch::default()
        },
        t,
    );
    assert!(!w.gates.game_guard);
    let located = |h| Batch {
        windows: vec![(
            h,
            Delta {
                bits: bit::LOCATED,
                last_ms: 1,
            },
        )],
        ..Batch::default()
    };
    // A video's "f": the same window loses its title bar and fills DISPLAY1.
    let windowed = w.probe.windows[&1].facts.clone();
    let video = &mut w.probe.windows.get_mut(&1).unwrap().facts;
    video.rect = two_monitors()[0].rect;
    video.style = 0x1600_0000;
    w.apply(&located(1), t + Duration::from_secs(1));
    assert!(w.gates.game_guard, "the move alone trips it");
    assert_eq!(w.windows[&1].v.facts.style, 0x1600_0000);
    let front = views::state(&w, t, 1).front.unwrap();
    assert!(front.game && front.rect.is_some());
    // Escape: windowed again, and the guard clears.
    w.probe.windows.get_mut(&1).unwrap().facts = windowed;
    w.apply(&located(1), t + Duration::from_secs(2));
    assert!(!w.gates.game_guard);
}

#[test]
fn the_panel_says_why_an_arrangeable_window_would_stay_put() {
    let tmp = tempfile::tempdir().unwrap();
    let mut p = probe_with(3);
    p.windows.get_mut(&1).unwrap().facts.iconic = true;
    let right = &mut p.windows.get_mut(&2).unwrap().facts.rect;
    right.left += 3000;
    right.right += 3000;
    let mut w = wm(p, tmp.path());
    w.set_panel(true);
    let state = views::state(&w, Instant::now(), 1);
    let row = |id: &str| state.windows.iter().find(|r| r.id == id).unwrap();
    assert_eq!(row("0x1").state, WindowState::Minimized);
    assert_eq!(row("0x1").why, "Minimized by you: left as it is");
    assert_eq!(row("0x2").why, "On DISPLAY2, which Nook leaves alone");
    assert_eq!(row("0x3").why, "A standard app window: Nook can arrange it");
    assert!(state.windows.iter().all(|r| r.verdict == VerdictName::Tile));
}

#[test]
fn a_session_lock_and_a_remote_session_set_their_gates() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = wm(probe_with(1), tmp.path());
    let t = Instant::now();
    w.probe.secure_desktop.set(true);
    w.apply(
        &Batch {
            global: global::DESKTOP_SWITCH,
            ..Batch::default()
        },
        t,
    );
    assert!(w.gates.session_locked);
    w.shell(Signal::Session(8), t);
    assert!(!w.gates.session_locked);
    w.shell(Signal::Session(3), t);
    assert!(w.gates.remote_session);
    assert_eq!(w.stats.unhide_alls, 1);
    w.shell(Signal::Session(1), t);
    assert!(!w.gates.remote_session && w.gates.user_paused);
}

#[test]
fn fixtures_replay_to_the_same_verdicts_without_titles() {
    let tmp = tempfile::tempdir().unwrap();
    let mut p = probe_with(2);
    let mut dialog = app_window("#32770", 300);
    dialog.title = Some("a secret title".into());
    dialog.facts.owner = 1;
    p.add(9, dialog)
        .proc(300, Ok(process(r"C:\Users\o\AppData\Local\App\app.exe")));
    p.add(10, app_window("RiotWindowClass", 301));
    let mut w = wm(p, tmp.path());
    w.set_panel(true);
    let file = fixtures::capture(&w, Some(r"C:\Users\o"));
    let text = serde_json::to_string(&file).unwrap();
    assert!(!text.contains("secret"), "no title is ever saved");
    assert!(text.contains(r"%USERPROFILE%\\AppData"));
    assert_eq!(file.windows.len(), 4);
    let rules = crate::nook::rules::Rules {
        default: crate::nook::rules::defaults().iter().collect(),
        ..Default::default()
    };
    assert!(fixtures::replay::differences(&file, &rules).is_empty());
    let path = fixtures::save(&w).unwrap();
    assert!(path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("fixtures-"));
}

#[test]
fn hearths_own_window_counts_as_in_front_but_the_bars_never_does() {
    let tmp = tempfile::tempdir().unwrap();
    let mut p = probe_with(1);
    // Hearth's own windows: pid 1 is this process in these tests.
    p.add(0x40, app_window("Tauri Window", 1));
    p.add(0xB0, app_window("Tauri Window", 1));
    let mut w = wm(p, tmp.path());
    w.chrome = vec![0xB0];
    let t = Instant::now();
    let front = |h| Batch {
        foreground: Some(h),
        ..Batch::default()
    };
    w.apply(&front(1), t);
    w.apply(&front(0x40), t);
    assert_eq!(w.focused, Some(0x40), "the settings window is in front");
    assert_eq!(w.windows[&0x40].v.why.code(), "own_process");
    w.apply(&front(0xB0), t);
    assert_eq!(w.focused, Some(0x40), "a click on the bar changes nothing");
    assert!(!w.windows.contains_key(&0xB0));
    assert_eq!(views::state(&w, t, 1).front.map(|f| f.hwnd), Some(0x40));
}

#[test]
fn only_the_whole_profile_folder_is_hidden_in_fixtures() {
    let a = |path, profile| fixtures::anonymize(path, Some(profile));
    assert_eq!(
        a(r"C:\Users\Bob\AppData\x.exe", r"C:\Users\Bob"),
        r"%USERPROFILE%\AppData\x.exe"
    );
    assert_eq!(
        a(r"c:\users\bob\x.exe", r"C:\Users\Bob\"),
        r"%USERPROFILE%\x.exe"
    );
    assert_eq!(a(r"C:\Users\Bob", r"C:\Users\Bob"), "%USERPROFILE%");
    assert_eq!(
        a(r"C:\Users\Bobby\x.exe", r"C:\Users\Bob"),
        r"C:\Users\Bobby\x.exe"
    );
    // The profile's length ends inside a character of the path: no panic, nothing replaced.
    assert_eq!(
        a(r"C:\Users\Bö\x.exe", r"C:\Users\Bo"),
        r"C:\Users\Bö\x.exe"
    );
    assert_eq!(a(r"C:\x.exe", ""), r"C:\x.exe");
    assert_eq!(fixtures::anonymize(r"C:\x.exe", None), r"C:\x.exe");
}

#[test]
fn with_the_panel_open_child_windows_tooltips_and_menus_stay_out_of_the_list() {
    let tmp = tempfile::tempdir().unwrap();
    let mut w = wm(probe_with(1), tmp.path());
    w.set_panel(true);
    let mut child = app_window("Chrome_RenderWidgetHostHWND", 100);
    child.facts.root = false;
    child.facts.style |= crate::nook::probe::style::WS_CHILD;
    w.probe.add(20, child);
    w.probe.add(21, app_window("tooltips_class32", 100));
    w.probe.add(22, app_window("#32768", 100));
    w.probe.add(23, app_window("Chrome_WidgetWin_1", 100));
    let verdicts = w.stats.verdicts;
    w.apply(
        &Batch {
            windows: vec![shown(20), shown(21), shown(22), shown(23)],
            ..Batch::default()
        },
        Instant::now(),
    );
    for h in [20, 21, 22] {
        assert!(!w.windows.contains_key(&h), "{h}");
    }
    assert!(w.windows.contains_key(&23), "a new app window is judged");
    assert_eq!(w.stats.verdicts, verdicts + 1);
}
