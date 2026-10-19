// P1's recorded experiments that can run without the owner's desktop (docs/nook-wm.md, "### P1"):
// a Chrome of the test's own, started on the private desktop with its own profile folder, with
// - DWMWA_TRANSITIONS_FORCEDISABLED set on its window from another process;
// - the LOCATIONCHANGE noise a per-pid hook on it hears;
// - its CPU with and without Nook's hooks on that desktop.
// They are ignored by default since they take about a minute and need Chrome; run them with
// `cargo test --lib nook::itest::experiments -- --ignored --nocapture --test-threads=1`.
// Click activation in a WS_EX_NOACTIVATE window and acrylic on a never-activated window need the
// owner's input desktop and eyes, so they are a script for the owner instead
// (apps/desktop/scripts/nook-experiments.ps1).

use super::desk::{Child, PrivateDesktop};
use super::pump_for;
use crate::nook::coalesce::event as e;
use crate::nook::hooks::{HookSet, PIPE};
use crate::nook::probe::Hwnd;
use crate::nook::window;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

const CHROME: &str = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
const EDGE: &str = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe";
/// A page that animates without moving its window, as an idle web app does.
const PAGE: &str =
    "data:text/html,%3Cstyle%3E%40keyframes%20s%7Bto%7Btransform%3AtranslateX(300px)\
    %7D%7Ddiv%7Bwidth%3A60px%3Bheight%3A60px%3Bbackground%3A%23c33%3Banimation%3As%201s%20\
    infinite%20alternate%7D%3C%2Fstyle%3E%3Cdiv%3E%3C%2Fdiv%3E";

fn browser() -> Option<PathBuf> {
    [CHROME, EDGE]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.exists())
}

/// Chromium on the desktop, with a profile folder of its own and its background traffic off.
fn start(desk: &PrivateDesktop, exe: &Path, profile: &Path) -> Child {
    let profile = format!("--user-data-dir={}", profile.display());
    desk.spawn(
        exe,
        &[
            &profile,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--disable-sync",
            "--disable-extensions",
            "--no-pings",
            // On a desktop nobody looks at, Chromium would otherwise stop painting.
            "--disable-features=CalculateNativeWinOcclusion",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--new-window",
            PAGE,
        ],
        &[],
    )
}

/// The browser's main window, once it has one.
fn main_window(pid: u32) -> Option<Hwnd> {
    let until = Instant::now() + Duration::from_secs(30);
    while Instant::now() < until {
        let found = window::top_level().into_iter().find(|&h| {
            window::pid_of(h) == pid
                && window::class_of(window::hwnd(h)) == "Chrome_WidgetWin_1"
                && crate::nook::probe::Probe::window(&window::RealProbe, h)
                    .is_some_and(|f| f.visible && f.rect.width() > 200)
        });
        if found.is_some() {
            return found;
        }
        pump_for(Duration::from_millis(250));
    }
    None
}

#[test]
#[ignore = "an experiment: needs Chrome or Edge and about a minute"]
fn chromium_on_the_private_desktop() {
    let Some(exe) = browser() else {
        println!("experiment skipped: neither Chrome nor Edge is installed");
        return;
    };
    let profile = tempfile::tempdir().unwrap();
    let desk = Arc::new(PrivateDesktop::create("chromium"));
    let d = desk.clone();
    let profile_dir = profile.path().to_path_buf();
    let lines = desk.on(move || {
        let mut out = Vec::new();
        let child = start(&d, &exe, &profile_dir);
        let Some(hwnd) = main_window(child.pid) else {
            out.push("no browser window appeared within 30 s".to_string());
            return out;
        };
        out.push(format!(
            "browser {} pid {} window {hwnd:#x}",
            exe.display(),
            child.pid
        ));
        out.push(transitions(hwnd));
        // Chromium's start-up dominates its first seconds, so it settles first; then four
        // rounds of 8 s without hooks and 8 s with them, so drift shows up as drift.
        pump_for(Duration::from_secs(15));
        let measure = |hooked: bool| {
            let mut hooks = HookSet::default();
            if hooked {
                hooks.start();
                hooks.panel(true);
                hooks.follow(Some(child.pid));
            }
            let in0 = PIPE.with(|p| p.borrow().events_in);
            let cpu0 = d.job_cpu();
            let t0 = Instant::now();
            pump_for(Duration::from_secs(8));
            let share = (d.job_cpu() - cpu0).as_secs_f64() / t0.elapsed().as_secs_f64();
            let heard = PIPE.with(|p| p.borrow().events_in) - in0;
            hooks.clear();
            (100.0 * share, heard)
        };
        let (mut without, mut with) = (Vec::new(), Vec::new());
        for round in 1..=4 {
            let (a, _) = measure(false);
            let (b, heard) = measure(true);
            out.push(format!(
                "round {round}: browser CPU {a:.1}% of one core without hooks, {b:.1}% with \
                 Nook's hooks (G1-G5, panel, F1 on the browser), which heard {heard} events"
            ));
            without.push(a);
            with.push(b);
        }
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        out.push(format!(
            "mean: {:.1}% without, {:.1}% with",
            mean(&without),
            mean(&with)
        ));
        out.push(noise(child.pid));
        out
    });
    for line in lines {
        println!("experiment {line}");
    }
}

/// DWMWA_TRANSITIONS_FORCEDISABLED, set from this process on the browser's window: whether
/// Windows lets one process turn off another's DWM transitions, as P2's arranging would.
fn transitions(hwnd: Hwnd) -> String {
    use windows::core::BOOL;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    let on = BOOL(1);
    let r = unsafe {
        DwmSetWindowAttribute(
            HWND(hwnd as *mut _),
            DWMWA_TRANSITIONS_FORCEDISABLED,
            &on as *const BOOL as *const _,
            std::mem::size_of::<BOOL>() as u32,
        )
    };
    match r {
        Ok(()) => "DWMWA_TRANSITIONS_FORCEDISABLED on the browser's window: S_OK".to_string(),
        Err(e) => format!(
            "DWMWA_TRANSITIONS_FORCEDISABLED on the browser's window: {:#010x} {}",
            e.code().0,
            e.message()
        ),
    }
}

/// LOCATIONCHANGE from the browser for 5 s, by object: how much of it a per-pid F1 would hear,
/// and how much the callback's whole-window filter throws away.
fn noise(pid: u32) -> String {
    use std::collections::BTreeMap;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
    use windows::Win32::UI::WindowsAndMessaging::{WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS};
    thread_local! {
        static SEEN: std::cell::RefCell<BTreeMap<i32, u64>> = Default::default();
    }
    unsafe extern "system" fn count(
        _: HWINEVENTHOOK,
        _: u32,
        _: HWND,
        obj: i32,
        _: i32,
        _: u32,
        _: u32,
    ) {
        let _ = SEEN.try_with(|s| *s.borrow_mut().entry(obj).or_default() += 1);
    }
    let flags = WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS;
    let range = e::LOCATION_CHANGE;
    let h = unsafe { SetWinEventHook(range, range, None, Some(count), pid, 0, flags) };
    pump_for(Duration::from_secs(5));
    unsafe {
        let _ = UnhookWinEvent(h);
    }
    let seen = SEEN.with(|s| s.borrow().clone());
    let total: u64 = seen.values().sum();
    let by: Vec<String> = seen
        .iter()
        .map(|(obj, n)| {
            let name = match obj {
                0 => "window",
                -8 => "caret",
                -9 => "cursor",
                -4 => "client",
                _ => "other",
            };
            format!("{name} ({obj}): {n}")
        })
        .collect();
    format!(
        "LOCATIONCHANGE for the browser's pid over 5 s: {total} [{}]",
        by.join(", ")
    )
}
