// Window handles and placements in a form the journal can store and FakeDesktop can model. They
// mirror Win32's HWND and WINDOWPLACEMENT field for field, so a placement read at adopt or hide
// time is written back exactly, maximized and minimized states included.

use serde::de::{self, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;

/// ShowWindow commands, as Win32 numbers them.
pub const SW_HIDE: u32 = 0;
pub const SW_SHOWNORMAL: u32 = 1;
pub const SW_SHOWMINIMIZED: u32 = 2;
pub const SW_SHOWMAXIMIZED: u32 = 3;
pub const SW_SHOWNOACTIVATE: u32 = 4;
pub const SW_SHOW: u32 = 5;
pub const SW_MINIMIZE: u32 = 6;
pub const SW_SHOWMINNOACTIVE: u32 = 7;
pub const SW_SHOWNA: u32 = 8;
pub const SW_RESTORE: u32 = 9;

/// WINDOWPLACEMENT flags, as Win32 numbers them.
pub const WPF_SETMINPOSITION: u32 = 1;
pub const WPF_RESTORETOMAXIMIZED: u32 = 2;
pub const WPF_ASYNCWINDOWPLACEMENT: u32 = 4;

/// A top-level window handle. The journal stores it as a "0x..." string, the way Spy++ and
/// Nook's log show it, so a person reading the file can match it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hwnd(pub isize);

impl fmt::Display for Hwnd {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:#x}", self.0 as usize)
    }
}

impl Serialize for Hwnd {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Hwnd {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct HwndVisitor;
        impl Visitor<'_> for HwndVisitor {
            type Value = Hwnd;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a window handle such as \"0x1a2b\"")
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Hwnd, E> {
                let digits = v.strip_prefix("0x").unwrap_or(v);
                usize::from_str_radix(digits, 16)
                    .map(|n| Hwnd(n as isize))
                    .map_err(|_| E::custom(format!("not a window handle: {v}")))
            }
            // An older or hand-edited journal may hold a plain number; it means the same window.
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Hwnd, E> {
                Ok(Hwnd(v as isize))
            }
        }
        d.deserialize_any(HwndVisitor)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Rect {
        Rect {
            left,
            top,
            right,
            bottom,
        }
    }
}

/// How a window sits, as GetWindowPlacement reports it: normal, minimized or maximized, the
/// rectangle it returns to, and whether it returns maximized.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub flags: u32,
    pub show_cmd: u32,
    pub min_position: Point,
    pub max_position: Point,
    pub normal_position: Rect,
}

/// The three states a window can be in, whichever show command put it there.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shown {
    Normal,
    Minimized,
    Maximized,
}

impl Placement {
    pub const fn normal(rect: Rect) -> Placement {
        Placement {
            flags: 0,
            show_cmd: SW_SHOWNORMAL,
            min_position: Point { x: -1, y: -1 },
            max_position: Point { x: -1, y: -1 },
            normal_position: rect,
        }
    }

    pub fn shown(&self) -> Shown {
        match self.show_cmd {
            SW_SHOWMINIMIZED | SW_MINIMIZE | SW_SHOWMINNOACTIVE => Shown::Minimized,
            SW_SHOWMAXIMIZED => Shown::Maximized,
            _ => Shown::Normal,
        }
    }

    pub fn is_minimized(&self) -> bool {
        self.shown() == Shown::Minimized
    }

    pub fn is_maximized(&self) -> bool {
        self.shown() == Shown::Maximized
    }

    /// Whether restoring this minimized window brings it back maximized.
    pub fn restores_maximized(&self) -> bool {
        self.is_minimized() && self.flags & WPF_RESTORETOMAXIMIZED != 0
    }

    /// The same placement, written so it takes no focus and never waits on the app.
    ///
    /// SW_SHOWNORMAL and SW_RESTORE would activate the window, so they become SW_SHOWNOACTIVATE;
    /// SW_SHOWMAXIMIZED has no quiet form and stays, so a maximized window comes back maximized.
    /// A minimized one stays minimized without activating, keeping its restore-to-maximized flag,
    /// which Windows honours only on a minimized placement.
    pub fn quiet(&self) -> Placement {
        let (show_cmd, keep) = match self.shown() {
            Shown::Minimized => (SW_SHOWMINNOACTIVE, WPF_RESTORETOMAXIMIZED),
            Shown::Maximized => (SW_SHOWMAXIMIZED, 0),
            Shown::Normal => (SW_SHOWNOACTIVATE, 0),
        };
        Placement {
            flags: (self.flags & (WPF_SETMINPOSITION | keep)) | WPF_ASYNCWINDOWPLACEMENT,
            show_cmd,
            ..*self
        }
    }

    /// Whether two placements put the window in the same state at the same normal rectangle,
    /// which is all the second pass needs to know a write landed.
    pub fn same_place(&self, other: &Placement) -> bool {
        self.shown() == other.shown() && self.normal_position == other.normal_position
    }
}
