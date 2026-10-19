// The test windows' own process. The tests run this test binary again on their private desktop,
// with NOOK_TESTWIN naming that desktop; it then makes the windows asked for, prints their
// handles, plays a short script on them and waits to be ended with its job. It refuses to make a
// single window unless its thread really is on that NookTest desktop, so run by hand, or by a
// plain `cargo test -- --ignored`, it does nothing at all.

use super::desk::{self, PREFIX};
use std::time::{Duration, Instant};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, MsgWaitForMultipleObjects,
    PeekMessageW, RegisterClassExW, SetWindowPos, ShowWindow, TranslateMessage, HMENU, MSG,
    PM_REMOVE, QS_ALLINPUT, SWP_NOACTIVATE, SWP_NOZORDER, SW_HIDE, SW_MINIMIZE, SW_RESTORE,
    SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSEXW,
};

pub const DESK_VAR: &str = "NOOK_TESTWIN";
pub const PLAN_VAR: &str = "NOOK_TESTWIN_PLAN";
/// What the host prints, so the harness's own lines can be told apart.
pub const TAG: &str = "nook-child";

const OVERLAPPED: u32 = 0x00CF_0000;
const POPUP: u32 = 0x8000_0000;
const CAPTION: u32 = 0x00C0_0000;
const SYSMENU: u32 = 0x0008_0000;
const MINIMIZEBOX: u32 = 0x0002_0000;
const TOOLWINDOW: u32 = 0x0000_0080;

/// The windows a plan can ask for: (kind, class, style, ex-style, owned by the first app).
const KINDS: &[(&str, &str, u32, u32, bool)] = &[
    ("app", "NookTestApp", OVERLAPPED, 0, false),
    ("owned", "NookTestOwned", OVERLAPPED, 0, true),
    (
        "fixed",
        "NookTestFixed",
        CAPTION | SYSMENU | MINIMIZEBOX,
        0,
        false,
    ),
    (
        "dialog",
        "NookTestDialog",
        POPUP | CAPTION | SYSMENU,
        0,
        true,
    ),
    ("tool", "NookTestTool", POPUP | CAPTION, TOOLWINDOW, false),
    ("riot", "RiotWindowClass", OVERLAPPED, 0, false),
    ("unity", "UnityWndClass", OVERLAPPED, 0, false),
    ("progman", "Progman", POPUP, TOOLWINDOW, false),
    ("workerw", "WorkerW", POPUP, TOOLWINDOW, false),
];

unsafe extern "system" fn plain(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(h, m, w, l) }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

fn say(line: impl AsRef<str>) {
    println!("{TAG} {}", line.as_ref());
}

/// Dispatches what arrived, then waits up to `d` for more, without spinning.
fn pump_for(d: Duration) {
    let until = Instant::now() + d;
    loop {
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        let Some(left) = until.checked_duration_since(Instant::now()) else {
            return;
        };
        let ms = left.as_millis().clamp(1, 1000) as u32;
        unsafe { MsgWaitForMultipleObjects(None, false, ms, QS_ALLINPUT) };
    }
}

fn make(kind: &str, n: i32, owner: Option<HWND>) -> Option<HWND> {
    let &(_, class, style, ex, owned) = KINDS.iter().find(|k| k.0 == kind)?;
    let module = unsafe { GetModuleHandleW(None) }.ok()?;
    let class_w = wide(class);
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(plain),
        hInstance: module.into(),
        lpszClassName: PCWSTR(class_w.as_ptr()),
        ..Default::default()
    };
    // A second window of a class registers it again, which fails harmlessly.
    unsafe { RegisterClassExW(&wc) };
    let title = wide(&format!("Nook test {kind} {n}"));
    let parent = if owned { owner } else { None };
    unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(ex),
            PCWSTR(class_w.as_ptr()),
            PCWSTR(title.as_ptr()),
            WINDOW_STYLE(style),
            80 + 40 * n,
            80 + 30 * n,
            640,
            420,
            parent,
            None::<HMENU>,
            Some(module.into()),
            None,
        )
    }
    .ok()
}

/// The plan's script: moves, minimizes, hides and shows each app window, then closes the last.
fn churn(apps: &[HWND]) {
    for (i, &h) in apps.iter().enumerate() {
        for step in 0..5 {
            unsafe {
                let _ = SetWindowPos(
                    h,
                    None,
                    100 + 10 * step + i as i32 * 50,
                    100 + 7 * step,
                    640,
                    420,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
            pump_for(Duration::from_millis(5));
        }
        for show in [SW_MINIMIZE, SW_RESTORE, SW_HIDE, SW_SHOWNOACTIVATE] {
            unsafe {
                let _ = ShowWindow(h, show);
            }
            pump_for(Duration::from_millis(20));
        }
    }
    if let Some(&last) = apps.last() {
        unsafe {
            let _ = DestroyWindow(last);
        }
        say(format!("destroyed {:#x}", last.0 as usize));
    }
}

#[test]
#[ignore = "the private-desktop tests start it; it does nothing on its own"]
fn window_host() {
    let Ok(want) = std::env::var(DESK_VAR) else {
        return;
    };
    let on = desk::this_thread();
    if !want.starts_with(PREFIX) || on != want {
        eprintln!("the window host runs only on its {PREFIX} desktop, not on {on:?}");
        return;
    }
    let plan = std::env::var(PLAN_VAR).unwrap_or_default();
    let (mut windows, mut script, mut delay, mut linger) = (Vec::new(), "", 300u64, 30u64);
    for part in plan.split(';') {
        match part.split_once('=') {
            Some(("windows", list)) => windows = list.split(',').collect(),
            Some(("script", s)) => script = s,
            Some(("delay", s)) => delay = s.parse().unwrap_or(300),
            Some(("linger", s)) => linger = s.parse().unwrap_or(30),
            _ => {}
        }
    }
    let mut apps: Vec<HWND> = Vec::new();
    for (n, kind) in windows.iter().enumerate() {
        let Some(h) = make(kind, n as i32, apps.first().copied()) else {
            say(format!("failed {kind}"));
            continue;
        };
        unsafe {
            let _ = ShowWindow(h, SW_SHOWNOACTIVATE);
        }
        if *kind == "app" {
            apps.push(h);
        }
        say(format!("hwnd {kind} {:#x}", h.0 as usize));
    }
    say("ready");
    pump_for(Duration::from_millis(delay));
    if script == "churn" {
        churn(&apps);
    }
    say("done");
    pump_for(Duration::from_secs(linger));
}
