// The hooks, nook-wm and the shell window on the private desktop. The hooks are installed by a
// thread joined to that desktop, and WinEvents reach only hooks on the desktop they happen on, so
// the owner's windows never come into these tests; each test checks that every window it heard
// about is its own window host's.

use super::desk::PrivateDesktop;
use super::{follow, host, pump_for, Announced, Guarded};
use crate::nook::coalesce::{bit, Batch};
use crate::nook::hooks::{HookSet, GLOBAL, PER_PROCESS, PIPE, TIMES};
use crate::nook::perf::Counters;
use crate::nook::probe::{Hwnd, Own};
use crate::nook::shell::{self, Shell, Signal};
use crate::nook::sync;
use crate::nook::vd::{self, Vd};
use crate::nook::view::{ModeName, NookState, VerdictName};
use crate::nook::window;
use crate::nook::wm::{self, thread::Config, Cmd};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

fn has(batch: &Batch, h: Hwnd, b: u16) -> bool {
    batch
        .windows
        .iter()
        .any(|&(w, d)| w == h && d.bits & b != 0)
}

#[test]
fn the_hooks_hear_only_the_test_windows_and_coalesce_them() {
    let desk = Arc::new(PrivateDesktop::create("hooks"));
    let d = desk.clone();
    let (counts, lines) = desk.on(move || {
        let mut hooks = HookSet::default();
        assert!(hooks.start(), "G1-G5 install");
        hooks.panel(true);
        assert!(hooks.panel_open());
        let child = host(
            &d,
            "windows=app,app,app,tool;script=churn;delay=500;linger=20",
        );
        hooks.add_pid(child.pid);
        hooks.follow(Some(child.pid));
        let installed = hooks.count();
        assert_eq!(installed, GLOBAL.len() + 2 * PER_PROCESS.len() + 1);
        assert_eq!(hooks.refused, 0);
        let mut seen = Announced::new();
        assert!(follow(&child, "ready", Duration::from_secs(20), &mut seen));
        PIPE.with(|p| seen.iter().for_each(|&(_, h)| p.borrow_mut().know(h)));
        assert_eq!(PIPE.with(|p| p.borrow().known_len()), seen.len());
        assert!(follow(&child, "done", Duration::from_secs(20), &mut seen));
        pump_for(Duration::from_millis(300));
        let mut batch = Batch::default();
        let (events_in, coalesced, dropped) = PIPE.with(|p| {
            let mut p = p.borrow_mut();
            p.drain_into(&mut batch);
            (p.events_in, p.coalesced, p.dropped)
        });
        let theirs = |h: Hwnd| seen.iter().any(|&(_, s)| s == h) || window::pid_of(h) == child.pid;
        for &(h, _) in &batch.windows {
            assert!(theirs(h), "{h:#x} isn't the test's window");
        }
        if let Some(f) = batch.foreground {
            assert!(theirs(f));
        }
        let apps: Vec<Hwnd> = seen
            .iter()
            .filter(|(k, _)| k == "app")
            .map(|&(_, h)| h)
            .collect();
        for &h in &apps {
            assert!(has(&batch, h, bit::SHOWN), "{h:#x} shown");
        }
        let last = *apps.last().unwrap();
        assert!(
            has(&batch, last, bit::DESTROYED),
            "the closed window's DESTROY"
        );
        for &h in &apps[..apps.len() - 1] {
            assert!(has(&batch, h, bit::MIN_START) && has(&batch, h, bit::MIN_END));
            assert!(has(&batch, h, bit::HIDDEN), "{h:#x} hidden");
            assert!(has(&batch, h, bit::LOCATED), "F1 heard {h:#x} move");
        }
        let callbacks = TIMES.with(|t| t.borrow().summary());
        hooks.clear();
        assert_eq!(hooks.count(), 0);
        let lines = vec![
            format!("hooks installed: {installed}, refused: {}", hooks.refused),
            format!("events in: {events_in}, coalesced: {coalesced}, dropped: {dropped}"),
            format!("windows in the flush: {}", batch.windows.len()),
            format!(
                "callbacks: {} (p50 under {} ns, p99 under {} ns, max under {} ns)",
                callbacks.count, callbacks.p50_ns, callbacks.p99_ns, callbacks.max_ns
            ),
        ];
        ((events_in, coalesced, batch.windows.len()), lines)
    });
    for line in lines {
        println!("hooks {line}");
    }
    let (events_in, coalesced, kept) = counts;
    assert!(
        events_in > kept as u64,
        "events coalesce into fewer windows"
    );
    assert!(coalesced > 0);
}

/// nook-wm itself, observing the window host with the panel open: it lists the host's windows
/// with their verdicts, writes nothing, sleeps when nothing happens and exports diag.json when
/// the perf script's event is set.
#[test]
fn nook_wm_observes_writes_nothing_and_sleeps_when_idle() {
    let desk = PrivateDesktop::create("wm");
    let tmp = tempfile::tempdir().unwrap();
    let child = host(
        &desk,
        "windows=app,app,riot,tool;script=churn;delay=1500;linger=30",
    );
    let probe = Guarded::default();
    probe.allow(child.pid);
    let (link, inbox) = wm::channel().unwrap();
    let counters = Arc::new(Counters::default());
    let event_name = format!("Local\\NookTest.Diag.{}", std::process::id());
    let (tx, states) = mpsc::channel::<NookState>();
    // nook-com on the same desktop, answering nook-wm's virtual-desktop questions.
    let vd = Vd::new().unwrap();
    let (asker, answers) = (vd.clone(), link.clone());
    let com = desk.thread(move || {
        vd::run(asker, move |a| {
            answers.send(Cmd::Vd(a));
        })
    });
    let cfg = Config {
        dir: tmp.path().to_path_buf(),
        own: Own {
            pid: std::process::id(),
            elevated: false,
        },
        observe: false,
        panel_open: true,
        follow_foreground: false,
        chrome: Vec::new(),
        export_event: Some(sync::own_event(&event_name).unwrap()),
        counters: counters.clone(),
        others: vec![("nook-com", vd.counters.clone())],
        vd: Some(vd.clone()),
        focus: Default::default(),
        publish: Box::new(move |s: &NookState| {
            let _ = tx.send(s.clone());
        }),
    };
    let guarded = probe.clone();
    let worker = desk.thread(move || wm::thread::run(guarded, inbox, cfg));
    let mut seen = Announced::new();
    // The host's lines are read here, off the desktop: this thread hooks nothing.
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline && !seen.iter().any(|(k, _)| k == "done") {
        if let Some(line) = child.wait_for(|_| true, Duration::from_millis(200)) {
            if let Some(rest) = line.strip_prefix(super::child::TAG).map(str::trim) {
                if let Some(h) = rest.strip_prefix("hwnd ") {
                    let (kind, hex) = h.split_once(' ').unwrap();
                    let hwnd = Hwnd::from_str_radix(hex.trim_start_matches("0x"), 16).unwrap();
                    seen.push((kind.to_string(), hwnd));
                } else if rest == "done" {
                    seen.push(("done".into(), 0));
                }
            }
        }
    }
    assert!(
        seen.iter().any(|(k, _)| k == "done"),
        "the host finished: {seen:?}"
    );
    // Let the trailing flush and publish land, then take the newest state.
    std::thread::sleep(Duration::from_millis(400));
    let state = states.try_iter().last().expect("nook-wm published");
    assert_eq!(state.mode, ModeName::Observing);
    assert_eq!((state.writes.attempted, state.writes.landed), (0, 0));
    let apps: Vec<Hwnd> = seen
        .iter()
        .filter(|(k, _)| k == "app")
        .map(|&(_, h)| h)
        .collect();
    let row = |h: Hwnd| state.windows.iter().find(|r| r.id == format!("{h:#x}"));
    let first = row(apps[0]).expect("the first app window is listed");
    assert_eq!(first.verdict, VerdictName::Tile);
    assert!(row(apps[1]).is_none(), "the closed window left the list");
    let riot = seen.iter().find(|(k, _)| k == "riot").unwrap().1;
    assert_eq!(row(riot).map(|r| r.verdict), Some(VerdictName::Ignore));
    for r in &state.windows {
        println!("wm row {} {:<16} {:?}: {}", r.id, r.class, r.verdict, r.why);
    }

    // Idle: nothing happens on the desktop, so nook-wm shouldn't wake.
    let before = counters.snapshot();
    std::thread::sleep(Duration::from_millis(2000));
    let after = counters.snapshot();
    let idle_wakeups = after.wakeups - before.wakeups;
    println!(
        "wm counters: wakeups {} (idle 2 s: {idle_wakeups}), events in {}, coalesced {}, \
         dropped {}, flushes {}",
        after.wakeups, after.events_in, after.coalesced, after.dropped, after.flushes
    );
    assert!(
        idle_wakeups <= 2,
        "{idle_wakeups} wakeups in 2 idle seconds"
    );

    // The perf script's export, through its named event.
    let event = sync::open_event(&event_name).unwrap();
    sync::set(&event);
    let file = tmp.path().join(crate::nook::perf::EXPORT_FILE);
    let until = Instant::now() + Duration::from_secs(5);
    while !file.exists() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(50));
    }
    let diag: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&file).expect("diag.json")).unwrap();
    assert_eq!(diag["writes"]["landed"], 0);
    assert_eq!(diag["writes"]["attempted"], 0);
    assert_eq!(
        diag["focus_restores"], 0,
        "counted apart from the seam's writes"
    );
    assert_eq!(diag["hooks"], GLOBAL.len() + PER_PROCESS.len());
    assert!(diag["threads"]["nook-wm"]["wakeups"].as_u64().unwrap() > 0);
    println!("wm diag.json: {diag}");
    assert!(
        diag["stats"]["vd_answers"].as_u64().unwrap() > 0,
        "nook-com answered"
    );
    assert!(link.send(Cmd::Stop));
    worker.join().expect("nook-wm stops cleanly");
    vd.stop();
    com.join().expect("nook-com stops cleanly");
    assert_eq!(
        probe
            .opened
            .lock()
            .unwrap()
            .iter()
            .filter(|&&p| p != child.pid)
            .count(),
        0
    );
}

#[test]
fn a_stop_before_the_shell_window_exists_still_ends_it() {
    let desk = PrivateDesktop::create("shell-stop");
    let shell = Arc::new(Shell::default());
    shell.stop();
    let s = shell.clone();
    let worker = desk.thread(move || shell::run(s, |_| {}));
    let until = Instant::now() + Duration::from_secs(5);
    while !worker.is_finished() && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(worker.is_finished(), "the shell loop ended on its own");
    worker.join().unwrap().expect("and cleanly");
    assert_eq!(shell.hwnd(), 0);
}

#[test]
fn the_shell_window_hears_broadcasts_and_stays_hidden() {
    let desk = PrivateDesktop::create("shell");
    let shell = Arc::new(Shell::default());
    let (tx, rx) = mpsc::channel();
    let s = shell.clone();
    let worker = desk.thread(move || shell::run(s, move |sig| tx.send(sig).unwrap()));
    let until = Instant::now() + Duration::from_secs(5);
    while shell.hwnd() == 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    let hwnd = shell.hwnd();
    assert_ne!(hwnd, 0, "the shell window was made");
    let facts = window::RealProbe;
    let f = crate::nook::probe::Probe::window(&facts, hwnd).unwrap();
    assert!(!f.visible, "Nook's shell window is never shown");
    assert_eq!(f.class, "NookShell");
    // A broadcast the shell window would get from Windows, posted to it directly.
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_DISPLAYCHANGE};
    unsafe {
        PostMessageW(
            Some(HWND(hwnd as *mut _)),
            WM_DISPLAYCHANGE,
            WPARAM(32),
            LPARAM(0),
        )
        .unwrap();
    }
    let got = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    // Registering for the display's state sends the current one, which isn't a change.
    assert_eq!(got, Signal::DisplayChange);
    assert!(rx.try_recv().is_err(), "nothing else was signalled");
    shell.stop();
    worker.join().unwrap().expect("the shell loop ends cleanly");
    let c = shell.counters.snapshot();
    println!(
        "shell counters: wakeups {}, messages {}",
        c.wakeups, c.messages
    );
}
