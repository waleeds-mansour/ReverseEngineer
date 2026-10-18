// RealDesktop against real windows, all made by this test on a desktop of its own. The desktop
// comes from CreateDesktopW and is never switched to, so nothing appears on screen; the test
// thread joins it with SetThreadDesktop before it creates anything, which also means EnumWindows
// there sees only this test's windows. The named objects use a tag of the test's own.

use super::support::TempDir;
use crate::clock::Clock;
use crate::desktop::real::RealDesktop;
use crate::desktop::{Desktop, DesktopError};
use crate::identity::{marker, Identity};
use crate::journal::{Hidden, HiddenBy, Journal, WindowEntry, Writer};
use crate::objects::session::SessionObjects;
use crate::objects::Signals;
use crate::placement::{Hwnd, Placement, Rect, SW_SHOWMAXIMIZED, SW_SHOWMINNOACTIVE};
use crate::recover::{restore_all, Context, Reason};
use std::sync::Arc;
use std::time::Duration;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{GENERIC_ALL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::StationsAndDesktops::{
    CreateDesktopW, GetThreadDesktop, SetThreadDesktop, DESKTOP_CONTROL_FLAGS,
};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, IsIconic, IsZoomed,
    PeekMessageW, RegisterClassW, TranslateMessage, MSG, PM_REMOVE, WINDOW_EX_STYLE, WNDCLASSW,
    WS_OVERLAPPEDWINDOW,
};

const CLASS: PCWSTR = w!("NookRestoreTestWindow");

unsafe extern "system" fn window_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(h, msg, w, l) }
}

fn pump() {
    let mut msg = MSG::default();
    unsafe {
        while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn make_window(at: Rect) -> Hwnd {
    let instance = unsafe { GetModuleHandleW(None) }.unwrap();
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance.into(),
        lpszClassName: CLASS,
        ..Default::default()
    };
    // Registering twice fails harmlessly; the class is the process's either way.
    unsafe { RegisterClassW(&class) };
    let (w, h) = (at.right - at.left, at.bottom - at.top);
    let style = WS_OVERLAPPEDWINDOW;
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS,
            w!("Nook test"),
            style,
            at.left,
            at.top,
            w,
            h,
            None,
            None,
            Some(instance.into()),
            None,
        )
    }
    .unwrap();
    Hwnd(hwnd.0 as isize)
}

/// Runs `body` on a fresh thread joined to a new private desktop, refusing to run it at all
/// unless the join worked.
fn on_private_desktop(name: &str, body: impl FnOnce() + Send + 'static) {
    let desktop_name = format!("NookTest-{}-{name}", unsafe { GetCurrentProcessId() });
    std::thread::spawn(move || {
        let wide: Vec<u16> = desktop_name.encode_utf16().chain([0]).collect();
        let flags = DESKTOP_CONTROL_FLAGS(0);
        let access = GENERIC_ALL.0;
        let desk =
            unsafe { CreateDesktopW(PCWSTR(wide.as_ptr()), None, None, flags, access, None) }
                .expect("a private desktop");
        unsafe { SetThreadDesktop(desk) }.expect("the thread joins the private desktop");
        let now_on = unsafe { GetThreadDesktop(GetCurrentThreadId()) }.unwrap();
        assert_eq!(
            now_on, desk,
            "still on the owner's desktop: stop before any window"
        );
        body();
    })
    .join()
    .unwrap();
}

fn context() -> Context {
    let mut ctx = Context::current(Some("1.2.3".into()));
    ctx.second_pass_after = Some(Duration::ZERO);
    // The writer is this test, so the late pass runs; with no wait, it only checks again.
    ctx.late_pass_after = Some(Duration::ZERO);
    ctx.lock_wait = Duration::from_millis(200);
    ctx
}

#[test]
fn real_windows_go_back_exactly_on_a_private_desktop() {
    on_private_desktop("restore", || {
        let dir = TempDir::new("private");
        let tag = format!("test-private-{}", std::process::id());
        let signals = Arc::new(SessionObjects::create(&tag).unwrap());
        let user = RealDesktop::restoring();
        let a = make_window(Rect::new(100, 100, 700, 500));
        let b = make_window(Rect::new(150, 120, 900, 700));
        user.set_placement(a, &Placement::normal(Rect::new(100, 100, 700, 500)).quiet())
            .unwrap();
        let mut maximized = Placement::normal(Rect::new(150, 120, 900, 700));
        maximized.show_cmd = SW_SHOWMAXIMIZED;
        user.set_placement(b, &maximized).unwrap();
        pump();
        assert!(unsafe { IsZoomed(HWND(b.0 as _)) }.as_bool());

        let ctx = context();
        let original_a = user.placement(a).unwrap();
        let original_b = user.placement(b).unwrap();
        let session = "private".to_string();
        let me = Identity::capture(&user, a).unwrap();
        let mut journal = Journal::new("1.2.3", session, me.pid, me.proc_start, ctx.boot_time_ms);
        let mut writer = Writer::claim(
            dir.store(),
            signals.as_ref(),
            &mut journal,
            Clock::current(),
        )
        .unwrap();
        let wm = RealDesktop::managing(signals.clone(), writer.epoch());

        // Adopt both, then hide B after the user maximized it over its tile.
        for (hwnd, original) in [(a, original_a), (b, original_b)] {
            let id = Identity::capture(&wm, hwnd).unwrap();
            journal.windows.push(WindowEntry {
                hwnd,
                pid: id.pid,
                proc_start: id.proc_start,
                class: id.class,
                original,
                ..WindowEntry::default()
            });
        }
        writer
            .write(signals.as_ref(), &mut journal, Clock::current())
            .unwrap();
        for (hwnd, tile) in [
            (a, Rect::new(0, 0, 640, 700)),
            (b, Rect::new(648, 0, 1288, 700)),
        ] {
            wm.set_marker(hwnd, marker::MANAGED).unwrap();
            wm.set_placement(hwnd, &Placement::normal(tile).quiet())
                .unwrap();
        }
        pump();
        let mut zoom = user.placement(b).unwrap();
        zoom.show_cmd = SW_SHOWMAXIMIZED;
        user.set_placement(b, &zoom).unwrap();
        pump();
        let before_hide = wm.placement(b).unwrap();
        journal.windows[1].hide_placement = Some(before_hide);
        journal.windows[1].hidden = Some(Hidden::Minimized);
        journal.windows[1].hidden_by = Some(HiddenBy::Nook);
        writer
            .write(signals.as_ref(), &mut journal, Clock::current())
            .unwrap();
        wm.set_marker(b, marker::MANAGED | marker::MINIMIZED)
            .unwrap();
        let hide = Placement {
            show_cmd: SW_SHOWMINNOACTIVE,
            ..before_hide
        };
        wm.set_placement(b, &hide).unwrap();
        pump();
        assert!(unsafe { IsIconic(HWND(b.0 as _)) }.as_bool());

        // EnumWindows on this desktop sees exactly the two marked windows of this test.
        let mut marked = wm.marked();
        let mut expected = vec![
            (a, marker::MANAGED),
            (b, marker::MANAGED | marker::MINIMIZED),
        ];
        marked.sort();
        expected.sort();
        assert_eq!(marked, expected);

        let report = restore_all(&user, &dir.store(), signals.as_ref(), &ctx, Reason::User);
        pump();
        assert_eq!((report.restored, report.skipped), (2, 0), "{report:?}");
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(user.placement(a).unwrap().same_place(&original_a));
        assert!(user.placement(b).unwrap().same_place(&original_b));
        assert!(unsafe { IsZoomed(HWND(b.0 as _)) }.as_bool());
        assert_eq!((user.marker(a), user.marker(b)), (None, None));
        assert!(signals.is_revoked(writer.epoch()));
        assert_eq!(wm.set_placement(a, &hide), Err(DesktopError::Revoked));

        for hwnd in [a, b] {
            unsafe {
                let _ = DestroyWindow(HWND(hwnd.0 as _));
            }
        }
        assert!(wm.marked().is_empty());
    });
}

#[test]
fn a_lost_journal_is_swept_from_the_markers_on_a_private_desktop() {
    on_private_desktop("sweep", || {
        let dir = TempDir::new("private-sweep");
        let tag = format!("test-private-sweep-{}", std::process::id());
        let signals = SessionObjects::create(&tag).unwrap();
        let user = RealDesktop::restoring();
        let a = make_window(Rect::new(100, 100, 700, 500));
        user.set_marker(a, marker::MANAGED | marker::MINIMIZED)
            .unwrap();
        let mut minimized = user.placement(a).unwrap();
        minimized.show_cmd = SW_SHOWMINNOACTIVE;
        user.set_placement(a, &minimized).unwrap();
        pump();
        assert!(unsafe { IsIconic(HWND(a.0 as _)) }.as_bool());
        std::fs::write(dir.store().path(), b"not json").unwrap();

        let report = restore_all(&user, &dir.store(), &signals, &context(), Reason::Guard);
        pump();
        assert_eq!(report.swept, Some(1));
        assert!(!unsafe { IsIconic(HWND(a.0 as _)) }.as_bool());
        assert_eq!(user.marker(a), None);
        unsafe {
            let _ = DestroyWindow(HWND(a.0 as _));
        }
    });
}
