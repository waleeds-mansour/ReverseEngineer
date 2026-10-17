// What a test window looks like right now, read on a thread joined to the private desktop, and
// what counts as Nook having left it changed: minimized, moved, un-maximized, hidden, cloaked,
// recoloured or still carrying the marker.

use nook_restore::desktop::Desktop;
use nook_restore::placement::Hwnd;
use nook_restore::{Placement, RealDesktop};
use std::ffi::c_void;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CLOAKED};
use windows::Win32::UI::WindowsAndMessaging::{IsIconic, IsZoomed};

#[derive(Clone, Debug, PartialEq)]
pub struct WinState {
    pub exists: bool,
    pub placement: Option<Placement>,
    pub visible: bool,
    pub iconic: bool,
    pub zoomed: bool,
    pub cloaked: Option<u32>,
    pub marker: Option<u32>,
    /// None when DWM won't report the border colour.
    pub border: Option<u32>,
}

fn dwm_u32(
    hwnd: HWND,
    attribute: windows::Win32::Graphics::Dwm::DWMWINDOWATTRIBUTE,
) -> Option<u32> {
    let mut value = 0u32;
    let ptr = &mut value as *mut u32 as *mut c_void;
    unsafe { DwmGetWindowAttribute(hwnd, attribute, ptr, 4) }.ok()?;
    Some(value)
}

/// Reads every window. Must run on a thread joined to the windows' desktop.
pub fn read(hwnds: &[Hwnd]) -> Vec<WinState> {
    let desk = RealDesktop::observing();
    hwnds
        .iter()
        .map(|&h| {
            let raw = HWND(h.0 as *mut c_void);
            WinState {
                exists: desk.is_window(h),
                placement: desk.placement(h),
                visible: desk.is_visible(h),
                iconic: unsafe { IsIconic(raw) }.as_bool(),
                zoomed: unsafe { IsZoomed(raw) }.as_bool(),
                cloaked: dwm_u32(raw, DWMWA_CLOAKED),
                marker: desk.marker(h),
                border: dwm_u32(raw, DWMWA_BORDER_COLOR),
            }
        })
        .collect()
}

/// Everything about `now` that differs from how the window was before Nook touched it. With
/// `keep_positions` a window may keep the place and size Nook gave it, but nothing else.
pub fn problems(i: usize, before: &WinState, now: &WinState, keep_positions: bool) -> Vec<String> {
    let mut found = Vec::new();
    let mut say = |what: &str| found.push(format!("window {i} {what}"));
    if !now.exists {
        say("is gone");
        return found;
    }
    let minimized = now.placement.is_some_and(|p| p.is_minimized());
    if now.iconic || minimized {
        say("is minimized");
    }
    if now.zoomed != before.zoomed && !keep_positions {
        say(if now.zoomed {
            "is maximized"
        } else {
            "is no longer maximized"
        });
    }
    let place = |s: &WinState| s.placement.map(|p| p.normal_position);
    if place(now) != place(before) && !keep_positions {
        say(&format!("is at {:?}, not {:?}", place(now), place(before)));
    }
    if !now.visible {
        say("is hidden");
    }
    if now.cloaked.unwrap_or(1) != 0 && now.cloaked != before.cloaked {
        say(&format!("is cloaked ({:?})", now.cloaked));
    }
    if let Some(bits) = now.marker {
        say(&format!("carries the marker {bits:#x}"));
    }
    if before.border.is_some() && now.border != before.border {
        say(&format!(
            "is recoloured ({:?}, was {:?})",
            now.border, before.border
        ));
    }
    found
}

/// How many windows show each of Nook's changes, for the witness check that the host's writes
/// really landed before a kill.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Dirt {
    pub minimized: usize,
    pub marked: usize,
    pub moved: usize,
    pub recoloured: usize,
}

pub fn dirt(before: &[WinState], now: &[WinState]) -> Dirt {
    let mut d = Dirt::default();
    for (b, n) in before.iter().zip(now) {
        d.minimized += usize::from(n.iconic);
        d.marked += usize::from(n.marker.is_some());
        let place = |s: &WinState| s.placement.map(|p| p.normal_position);
        d.moved += usize::from(place(b) != place(n));
        d.recoloured += usize::from(b.border.is_some() && b.border != n.border);
    }
    d
}
