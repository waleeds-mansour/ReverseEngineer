// Nook off means off (docs/nook-wm.md, P0's exit criteria): with every switch off, the disabled
// file there, or switches on that this version can't act on, starting Hearth decides on no start
// check and so starts no thread, and deciding installs no WinEvent hook and creates no window.
// The decision runs on a thread joined to a private desktop of the test's own, made with
// CreateDesktopW and never switched to, so the before and after readings see nothing of the
// owner's. Registering a hotkey to probe for Nook's is left out on purpose: the probe itself
// would take the owner's keys.

use super::host::plan;
use super::settings::NookSettings;
use nook_restore::journal::{Journal, State, Store};
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{GENERIC_ALL, HWND, LPARAM};
use windows::Win32::System::StationsAndDesktops::{
    CreateDesktopW, EnumDesktopWindows, GetThreadDesktop, SetThreadDesktop, DESKTOP_CONTROL_FLAGS,
    HDESK,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::UI::Accessibility::IsWinEventHookInstalled;

/// Every WinEvent the window manager's hook thread will listen for.
const NOOK_EVENTS: [u32; 13] = [
    0x0003, 0x000A, 0x000B, 0x0016, 0x0017, 0x8000, 0x8001, 0x8002, 0x8003, 0x800B, 0x800C, 0x8017,
    0x8018,
];

fn hooks_installed() -> Vec<bool> {
    NOOK_EVENTS
        .iter()
        .map(|&event| unsafe { IsWinEventHookInstalled(event) }.as_bool())
        .collect()
}

unsafe extern "system" fn count(_: HWND, lparam: LPARAM) -> BOOL {
    unsafe { *(lparam.0 as *mut usize) += 1 };
    BOOL(1)
}

fn windows_on(desk: HDESK) -> usize {
    let mut n = 0usize;
    unsafe {
        let _ = EnumDesktopWindows(Some(desk), Some(count), LPARAM(&mut n as *mut _ as isize));
    }
    n
}

fn journal_in(dir: &std::path::Path, state: State) {
    let mut journal = Journal::new("1.2.3", "off".into(), 1, 1, 0);
    journal.state = state;
    Store::in_dir(dir).save(&journal).unwrap();
}

#[test]
fn nook_off_installs_no_hook_creates_no_window_and_starts_no_check() {
    let name = format!("NookOff-{}", unsafe { GetCurrentProcessId() });
    std::thread::spawn(move || {
        let wide: Vec<u16> = name.encode_utf16().chain([0]).collect();
        let flags = DESKTOP_CONTROL_FLAGS(0);
        let desk = unsafe {
            CreateDesktopW(
                PCWSTR(wide.as_ptr()),
                None,
                None,
                flags,
                GENERIC_ALL.0,
                None,
            )
        }
        .expect("a private desktop");
        unsafe { SetThreadDesktop(desk) }.expect("the thread joins the private desktop");
        let on = unsafe { GetThreadDesktop(GetCurrentThreadId()) }.unwrap();
        assert_eq!(on, desk, "still on the owner's desktop: stop here");

        let hooks_before = hooks_installed();
        let windows_before = windows_on(desk);
        let on_settings = NookSettings {
            enabled: true,
            auto_manage: true,
            bar: true,
            keymap: true,
            ..NookSettings::default()
        };
        for case in [
            "missing",
            "clean",
            "clean-for-update",
            "disabled",
            "switched-on",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join("nook");
            match case {
                "clean" => journal_in(&dir, State::Clean),
                "clean-for-update" => journal_in(&dir, State::CleanForUpdate),
                "disabled" => {
                    std::fs::create_dir_all(&dir).unwrap();
                    std::fs::write(dir.join(super::start::DISABLED_FILE), "").unwrap();
                }
                _ => {}
            }
            let settings = match case {
                "disabled" | "switched-on" => on_settings.clone(),
                _ => NookSettings::default(),
            };
            let plan = plan(&dir, &settings);
            assert!(!plan.check, "{case}: no start check, so no thread");
            assert!(!plan.status.arranges(), "{case}: {:?}", plan.status);
        }
        assert_eq!(hooks_installed(), hooks_before, "no WinEvent hook appeared");
        assert_eq!(windows_on(desk), windows_before, "no window appeared");
        assert_eq!(
            windows_before, 0,
            "the private desktop holds nothing of the owner's"
        );
    })
    .join()
    .unwrap();
}

#[test]
fn a_journal_that_still_owes_a_window_does_start_the_check() {
    let tmp = tempfile::tempdir().unwrap();
    let mut journal = Journal::new("1.2.3", "owed".into(), 1, 1, 0);
    journal.state = State::Clean;
    journal.windows.push(nook_restore::journal::WindowEntry {
        border_set: true,
        ..Default::default()
    });
    Store::in_dir(tmp.path()).save(&journal).unwrap();
    assert!(plan(tmp.path(), &NookSettings::default()).check);
}
