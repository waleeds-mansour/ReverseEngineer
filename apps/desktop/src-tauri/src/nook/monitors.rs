// The monitors (docs/nook-wm.md, "settling" and "display_missing"), each with an id that stays
// the same across sleeps, resolution changes and replugging: the monitor's device-interface path
// from EnumDisplayDevicesW, like "\\?\DISPLAY#GSM5B7F#...". The \\.\DISPLAYn names Windows gives
// can trade places, so they are shown but never used to recognise a monitor. Nook arranges the
// primary monitor only: the owner chose to leave every other one alone (display2=leave).

use super::probe::Rect;
use serde::Serialize;
use windows::core::{BOOL, PCWSTR};
use windows::Win32::Foundation::{LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, DISPLAY_DEVICEW, HDC, HMONITOR,
    MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
use windows::Win32::UI::WindowsAndMessaging::{
    EDD_GET_DEVICE_INTERFACE_NAME, MONITORINFOF_PRIMARY,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Monitor {
    /// The stable id.
    pub id: String,
    /// "DISPLAY1", for people.
    pub name: String,
    pub rect: Rect,
    pub work: Rect,
    pub dpi: u32,
    pub primary: bool,
}

impl Monitor {
    /// Whether Nook arranges this monitor: the primary one only (display2=leave).
    pub fn managed(&self) -> bool {
        self.primary
    }

    pub fn note(&self) -> &'static str {
        if self.managed() {
            "Nook can arrange this monitor"
        } else {
            "Left alone: Nook never arranges or bars this monitor"
        }
    }
}

fn rect(r: RECT) -> Rect {
    Rect {
        left: r.left,
        top: r.top,
        right: r.right,
        bottom: r.bottom,
    }
}

fn wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

/// The device-interface path of the first active monitor on `adapter` (\\.\DISPLAYn).
fn interface_id(adapter: &[u16]) -> Option<String> {
    let mut dd = DISPLAY_DEVICEW {
        cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
        ..Default::default()
    };
    let ok = unsafe {
        EnumDisplayDevicesW(
            PCWSTR(adapter.as_ptr()),
            0,
            &mut dd,
            EDD_GET_DEVICE_INTERFACE_NAME,
        )
    };
    let id = wide(&dd.DeviceID);
    (ok.as_bool() && !id.is_empty()).then_some(id)
}

fn describe(h: HMONITOR) -> Option<Monitor> {
    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if !unsafe { GetMonitorInfoW(h, &mut info as *mut MONITORINFOEXW as *mut MONITORINFO) }
        .as_bool()
    {
        return None;
    }
    let device = wide(&info.szDevice);
    let mut adapter: Vec<u16> = device.encode_utf16().collect();
    adapter.push(0);
    let (mut dx, mut dy) = (96u32, 96u32);
    let _ = unsafe { GetDpiForMonitor(h, MDT_EFFECTIVE_DPI, &mut dx, &mut dy) };
    Some(Monitor {
        id: interface_id(&adapter).unwrap_or_else(|| device.clone()),
        name: device.trim_start_matches(r"\\.\").to_string(),
        rect: rect(info.monitorInfo.rcMonitor),
        work: rect(info.monitorInfo.rcWork),
        dpi: dx,
        primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
    })
}

unsafe extern "system" fn each(h: HMONITOR, _: HDC, _: *mut RECT, lparam: LPARAM) -> BOOL {
    let list = unsafe { &mut *(lparam.0 as *mut Vec<HMONITOR>) };
    list.push(h);
    BOOL(1)
}

/// Every monitor, the primary first, then left to right.
pub fn enumerate() -> Vec<Monitor> {
    let mut handles: Vec<HMONITOR> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(each),
            LPARAM(&mut handles as *mut _ as isize),
        );
    }
    let mut list: Vec<Monitor> = handles.into_iter().filter_map(describe).collect();
    list.sort_by_key(|m| (!m.primary, m.rect.left, m.rect.top));
    list
}

/// The monitor in `list` whose rect holds the middle of `r`.
pub fn holding<'a>(list: &'a [Monitor], r: &Rect) -> Option<&'a Monitor> {
    let (x, y) = r.center();
    list.iter().find(|m| m.rect.contains_point(x, y))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reading the monitor list changes nothing, so this one test reads the owner's real list.
    #[test]
    fn every_monitor_has_a_stable_id_and_one_is_primary() {
        let list = enumerate();
        assert!(!list.is_empty());
        assert_eq!(list.iter().filter(|m| m.primary).count(), 1);
        assert!(list[0].primary, "the primary comes first");
        for m in &list {
            assert!(!m.id.is_empty() && !m.name.is_empty());
            assert!(m.rect.width() > 0 && m.dpi >= 96, "{m:?}");
            assert!(m.work.width() <= m.rect.width());
        }
        let ids: std::collections::HashSet<_> = list.iter().map(|m| &m.id).collect();
        assert_eq!(ids.len(), list.len(), "ids are distinct");
        assert_eq!(enumerate(), list, "the same twice");
    }

    #[test]
    fn only_the_primary_is_managed() {
        let m = |primary| Monitor {
            id: "x".into(),
            name: "DISPLAY1".into(),
            rect: Rect::default(),
            work: Rect::default(),
            dpi: 96,
            primary,
        };
        assert!(m(true).managed());
        assert!(!m(false).managed());
        assert!(m(false).note().starts_with("Left alone"));
    }

    #[test]
    fn a_window_belongs_to_the_monitor_holding_its_middle() {
        let a = Monitor {
            id: "a".into(),
            name: "DISPLAY1".into(),
            rect: Rect {
                left: 0,
                top: 0,
                right: 2560,
                bottom: 1440,
            },
            work: Rect::default(),
            dpi: 96,
            primary: true,
        };
        let mut b = a.clone();
        b.id = "b".into();
        b.rect = Rect {
            left: 2560,
            top: 0,
            right: 6000,
            bottom: 1440,
        };
        let list = [a, b];
        let win = Rect {
            left: 2000,
            top: 100,
            right: 3400,
            bottom: 900,
        };
        assert_eq!(holding(&list, &win).map(|m| m.id.as_str()), Some("b"));
    }
}
