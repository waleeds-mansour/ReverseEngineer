// Plain windows for Nook's kill tests (docs/nook-wm.md, "Testing"). It makes them on whatever
// desktop it was started on, and the tests start it on a private desktop of their own, so these
// are the only windows a test ever writes to. It refuses to run anywhere else, so it can never put
// test windows on the owner's desktop by mistake.
//
// `nook-testwin [--count=N] [--maximized=1,3]` prints one line per window,
// `hwnd 0x1a2b normal|maximized`, then `ready`, and pumps messages until it is killed.

#[cfg(windows)]
#[path = "shared/desktop.rs"]
mod desktop;

#[cfg(windows)]
fn main() {
    use std::io::Write as _;
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, ShowWindow,
        TranslateMessage, MSG, SW_SHOWMAXIMIZED, SW_SHOWNOACTIVATE, WINDOW_EX_STYLE, WNDCLASSW,
        WS_OVERLAPPEDWINDOW,
    };

    unsafe extern "system" fn window_proc(h: HWND, msg: u32, w: WPARAM, l: LPARAM) -> LRESULT {
        unsafe { DefWindowProcW(h, msg, w, l) }
    }

    desktop::require_test_desktop("nook-testwin");
    let mut count = 4usize;
    let mut maximized: Vec<usize> = vec![1, 3];
    for arg in std::env::args().skip(1) {
        if let Some(n) = arg.strip_prefix("--count=") {
            count = n.parse().unwrap_or(count).clamp(1, 16);
        } else if let Some(list) = arg.strip_prefix("--maximized=") {
            maximized = list.split(',').filter_map(|i| i.parse().ok()).collect();
        }
    }

    const CLASS: PCWSTR = w!("NookTestWin");
    let instance = unsafe { GetModuleHandleW(None) }.expect("this program's module");
    let class = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: instance.into(),
        lpszClassName: CLASS,
        ..Default::default()
    };
    unsafe { RegisterClassW(&class) };
    let mut out = std::io::stdout().lock();
    for i in 0..count {
        let (x, y) = (120 + 70 * i as i32, 90 + 50 * i as i32);
        let title = HSTRING::from(format!("Nook test window {i}"));
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                CLASS,
                &title,
                WS_OVERLAPPEDWINDOW,
                x,
                y,
                640,
                480,
                None,
                None,
                Some(instance.into()),
                None,
            )
        }
        .expect("a test window");
        // A maximized window can only be shown by activating it, which on a private desktop
        // takes nothing from the owner: that desktop never has the keyboard.
        let max = maximized.contains(&i);
        let show = if max {
            SW_SHOWMAXIMIZED
        } else {
            SW_SHOWNOACTIVATE
        };
        unsafe {
            let _ = ShowWindow(hwnd, show);
        }
        let state = if max { "maximized" } else { "normal" };
        let _ = writeln!(out, "hwnd {:#x} {state}", hwnd.0 as usize);
    }
    let _ = writeln!(out, "ready");
    let _ = out.flush();
    drop(out);

    // GetMessage blocks, so an idle test window costs nothing; the asynchronous placements Nook
    // posts are handled here as they arrive.
    let mut msg = MSG::default();
    while unsafe { GetMessageW(&mut msg, None, 0, 0) }.0 > 0 {
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("nook-testwin makes Windows windows, so it runs only on Windows.");
    std::process::exit(3);
}
