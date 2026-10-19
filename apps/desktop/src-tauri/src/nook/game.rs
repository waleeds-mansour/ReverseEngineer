// The game guard (docs/nook-wm.md, "GATES" and "ANTI-CHEAT AND GAME POLICY"). It trips while a
// game or a fullscreen video is in front, and then Nook places nothing and its bar and popover
// hide. It is judged on every foreground change from facts Nook already has: the shell's
// notification state, cached for 250 ms; the foreground window's rect and style; and the game
// folder or class from that window's cached verdict. It never opens a process.

use super::eligibility::{game_path, shell_class, GAME_CLASSES, LIKELY_GAME_CLASSES};
use super::probe::style::WS_CAPTION;
use super::probe::Rect;
use std::time::{Duration, Instant};

/// How long SHQueryUserNotificationState's answer is kept.
pub const QUNS_FOR: Duration = Duration::from_millis(250);
const QUNS_RUNNING_D3D_FULL_SCREEN: i32 = 3;
const QUNS_PRESENTATION_MODE: i32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tripped {
    /// A Direct3D app runs exclusive fullscreen.
    D3dFullscreen,
    /// Windows' presentation mode is on.
    Presenting,
    /// The foreground window covers its whole monitor and has no title bar: a borderless game
    /// or a fullscreen video.
    Fullscreen,
    /// The foreground app lives in a game folder.
    GameFolder,
    /// The foreground window has a game engine's class.
    GameClass,
}

impl Tripped {
    pub fn text(self) -> &'static str {
        match self {
            Tripped::D3dFullscreen => "A fullscreen game is running",
            Tripped::Presenting => "Presentation mode is on",
            Tripped::Fullscreen => "Something fullscreen is in front",
            Tripped::GameFolder | Tripped::GameClass => "A game is in front",
        }
    }
}

/// What the guard knows about the foreground window.
pub struct Front<'a> {
    pub class: &'a str,
    pub style: u32,
    pub rect: Rect,
    /// The rect of the monitor the window is on, when it is on one: the class and folder are
    /// judged without it.
    pub monitor: Option<Rect>,
    /// The image path, when its verdict already opened the process.
    pub path: Option<&'a str>,
}

/// Whether the guard trips. QUNS_BUSY is ignored: the NVIDIA overlay sets it when nothing is
/// fullscreen.
pub fn judge(quns: Option<i32>, front: Option<&Front<'_>>) -> Option<Tripped> {
    match quns {
        Some(QUNS_RUNNING_D3D_FULL_SCREEN) => return Some(Tripped::D3dFullscreen),
        Some(QUNS_PRESENTATION_MODE) => return Some(Tripped::Presenting),
        _ => {}
    }
    let front = front?;
    let class_is = |list: &[&str]| list.iter().any(|c| c.eq_ignore_ascii_case(front.class));
    if class_is(GAME_CLASSES) || class_is(LIKELY_GAME_CLASSES) {
        return Some(Tripped::GameClass);
    }
    if front.path.and_then(game_path).is_some() {
        return Some(Tripped::GameFolder);
    }
    // The desktop is as big as its monitor and has no title bar, and is in front whenever the
    // owner clicks it.
    let fullscreen = front.monitor.is_some_and(|m| m == front.rect)
        && front.style & WS_CAPTION != WS_CAPTION
        && !shell_class(front.class);
    fullscreen.then_some(Tripped::Fullscreen)
}

/// The notification state, read at most once per 250 ms.
#[derive(Default)]
pub struct QunsCache {
    at: Option<(Instant, Option<i32>)>,
    pub reads: u64,
}

impl QunsCache {
    pub fn get(&mut self, now: Instant, read: impl FnOnce() -> Option<i32>) -> Option<i32> {
        if let Some((t, v)) = self.at {
            if now.saturating_duration_since(t) < QUNS_FOR {
                return v;
            }
        }
        self.reads += 1;
        let v = read();
        self.at = Some((now, v));
        v
    }
}

/// SHQueryUserNotificationState, or None when the shell doesn't answer.
#[cfg(windows)]
pub fn notification_state() -> Option<i32> {
    unsafe { windows::Win32::UI::Shell::SHQueryUserNotificationState() }
        .ok()
        .map(|s| s.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        left: 0,
        top: 0,
        right: 2560,
        bottom: 1440,
    };

    fn front<'a>(class: &'a str, style: u32, rect: Rect, path: Option<&'a str>) -> Front<'a> {
        Front {
            class,
            style,
            rect,
            monitor: Some(SCREEN),
            path,
        }
    }

    #[test]
    fn exclusive_fullscreen_and_presentations_trip_it() {
        assert_eq!(judge(Some(3), None), Some(Tripped::D3dFullscreen));
        assert_eq!(judge(Some(4), None), Some(Tripped::Presenting));
        assert_eq!(judge(Some(2), None), None, "QUNS_BUSY is ignored");
        assert_eq!(judge(Some(5), None), None);
    }

    #[test]
    fn a_borderless_window_the_size_of_its_monitor_trips_it() {
        let video = front("Chrome_WidgetWin_1", 0x1600_0000, SCREEN, None);
        assert_eq!(judge(Some(5), Some(&video)), Some(Tripped::Fullscreen));
        let maximized = front("Chrome_WidgetWin_1", 0x16CF_0000, SCREEN, None);
        assert_eq!(
            judge(Some(5), Some(&maximized)),
            None,
            "a maximized window has its caption"
        );
        let mut smaller = SCREEN;
        smaller.bottom -= 40;
        let windowed = front("Chrome_WidgetWin_1", 0x1600_0000, smaller, None);
        assert_eq!(judge(Some(5), Some(&windowed)), None);
        let desktop = front("Progman", 0x9600_0000, SCREEN, None);
        assert_eq!(
            judge(Some(5), Some(&desktop)),
            None,
            "the desktop isn't fullscreen"
        );
    }

    #[test]
    fn a_game_off_every_monitor_still_trips_it_by_class_or_folder() {
        let gone = Rect {
            left: -32000,
            top: -32000,
            right: -31840,
            bottom: -31972,
        };
        let mut league = front("RiotWindowClass", 0x16CF_0000, gone, None);
        league.monitor = None;
        assert_eq!(judge(Some(5), Some(&league)), Some(Tripped::GameClass));
        let mut steam = front(
            "SDL_window",
            0x1600_0000,
            gone,
            Some(r"D:\Steam\steamapps\common\G\g.exe"),
        );
        steam.monitor = None;
        assert_eq!(judge(Some(5), Some(&steam)), Some(Tripped::GameFolder));
        let mut other = front("Chrome_WidgetWin_1", 0x1600_0000, gone, None);
        other.monitor = None;
        assert_eq!(judge(Some(5), Some(&other)), None);
    }

    #[test]
    fn a_game_in_front_trips_it_even_windowed() {
        let small = Rect {
            left: 10,
            top: 10,
            right: 1290,
            bottom: 730,
        };
        let league = front("RiotWindowClass", 0x16CF_0000, small, None);
        assert_eq!(judge(Some(5), Some(&league)), Some(Tripped::GameClass));
        let steam = front(
            "SDL_window",
            0x16CF_0000,
            small,
            Some(r"D:\Steam\steamapps\common\G\g.exe"),
        );
        assert_eq!(judge(Some(5), Some(&steam)), Some(Tripped::GameFolder));
    }

    #[test]
    fn the_shell_is_asked_at_most_every_250_ms() {
        let t0 = Instant::now();
        let mut cache = QunsCache::default();
        assert_eq!(cache.get(t0, || Some(5)), Some(5));
        assert_eq!(
            cache.get(t0 + Duration::from_millis(100), || Some(3)),
            Some(5)
        );
        assert_eq!(cache.get(t0 + QUNS_FOR, || Some(3)), Some(3));
        assert_eq!(cache.reads, 2);
    }
}
