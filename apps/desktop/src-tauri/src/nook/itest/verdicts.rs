// Verdicts for real windows on the private desktop: the shell's classes and the game classes are
// ignored before any process is opened, an ordinary app window tiles, and owned, fixed-size and
// tool windows get the reasons the panel shows.

use super::desk::PrivateDesktop;
use super::{follow, host, Announced, Guarded};
use crate::nook::eligibility::{decide, Kind, Stage};
use crate::nook::probe::{Own, Probe};
use crate::nook::rules::{defaults, Rules};
use std::time::Duration;

#[test]
fn shell_and_game_classes_are_ignored_without_opening_their_process() {
    let desk = PrivateDesktop::create("verdicts");
    let child = host(
        &desk,
        "windows=progman,workerw,riot,unity,app,owned,fixed,dialog,tool;linger=20",
    );
    let pid = child.pid;
    let (lines, probe) = desk.on(move || {
        let mut seen = Announced::new();
        assert!(
            follow(&child, "ready", Duration::from_secs(20), &mut seen),
            "the window host didn't start"
        );
        let probe = Guarded::default();
        probe.allow(pid);
        let own = Own {
            pid: std::process::id(),
            elevated: false,
        };
        let rules = Rules {
            default: defaults().iter().collect(),
            ..Rules::default()
        };
        let listed = probe.top_level();
        let mut lines = Vec::new();
        for (kind, hwnd) in &seen {
            assert!(listed.contains(hwnd), "{kind} is on the desktop's list");
            let before = probe.opens();
            let v = decide(&probe, own, &rules, *hwnd, Some(true)).expect("a verdict");
            let opened = probe.opens() - before;
            lines.push(format!(
                "{kind:8} {:22} {:?} {:?} {} opens={opened}: {}",
                v.facts.class,
                v.kind,
                v.stage,
                v.why.code(),
                v.why.text()
            ));
            match kind.as_str() {
                "progman" | "workerw" => {
                    assert_eq!((v.kind, v.why.code()), (Kind::Ignore, "shell_class"));
                    assert_eq!((v.stage, opened), (Stage::A, 0), "{kind}");
                }
                "riot" => {
                    assert_eq!((v.kind, v.why.code()), (Kind::Ignore, "game_class"));
                    assert_eq!(opened, 0, "Riot's process is never opened");
                }
                "unity" => {
                    assert_eq!((v.kind, v.why.code()), (Kind::Ignore, "likely_game"));
                    assert_eq!(opened, 0, "a likely game's process isn't opened");
                }
                "app" => {
                    assert_eq!((v.kind, v.why.code()), (Kind::Tile, "standard"));
                    assert!(opened <= 1);
                    let exe = v.exe.clone().unwrap_or_default();
                    assert!(exe.starts_with("handy_app_lib"), "{exe}");
                }
                "owned" => assert_eq!((v.kind, v.why.code()), (Kind::Float, "owned")),
                "fixed" => assert_eq!((v.kind, v.why.code()), (Kind::Float, "fixed_size")),
                "dialog" => assert_eq!((v.kind, v.why.code()), (Kind::Ignore, "bare_popup")),
                "tool" => assert_eq!((v.kind, v.why.code()), (Kind::Ignore, "tool_window")),
                other => panic!("unexpected window {other}"),
            }
        }
        assert_eq!(seen.len(), 9, "every window was made: {seen:?}");
        (lines, probe)
    });
    for line in &lines {
        println!("verdict {line}");
    }
    // The class checks came first, so the only process opened is the app's, once, for the
    // windows that got past Stage A and B; the cache is nook-wm's, not decide's.
    let opened = probe.opened.lock().unwrap().clone();
    assert!(opened.iter().all(|&p| p == pid));
    println!(
        "process opens: {} (all of the test's own window host)",
        opened.len()
    );
}
