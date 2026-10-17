// What the tests share: a temp dir, a fixed context, a few app windows, and a window manager
// stand-in that follows the design's write-ahead order (journal first, then marker, then move).

use crate::clock::Clock;
use crate::desktop::fake::{FakeDesktop, FakeSignals, FakeWindow};
use crate::desktop::{Desktop, Mode};
use crate::identity::{marker, Identity};
use crate::journal::{Hidden, HiddenBy, Journal, Store, WindowEntry, Writer};
use crate::placement::{Hwnd, Placement, Rect, SW_SHOWMINNOACTIVE, WPF_ASYNCWINDOWPLACEMENT};
use crate::recover::Context;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

pub const VERSION: &str = "1.2.3";
pub const WM_PID: u32 = 100;
pub const WM_START: u64 = 1_000;
pub const NOW: u64 = 1_760_000_000_000;
pub const BOOT: u64 = NOW - 3_600_000;
/// Windows' tick count at NOW: an hour since it started.
pub const TICKS: u64 = 3_600_000;
pub const CLOCK: Clock = Clock {
    now_ms: NOW,
    ticks_ms: TICKS,
};

pub const CHROME: Hwnd = Hwnd(0x10);
pub const CODE: Hwnd = Hwnd(0x20);
pub const NOTES: Hwnd = Hwnd(0x30);
pub const MUSIC: Hwnd = Hwnd(0x40);

pub const R_CHROME: Rect = Rect::new(100, 100, 900, 700);
pub const R_CODE: Rect = Rect::new(200, 150, 1200, 900);
pub const R_NOTES: Rect = Rect::new(300, 200, 800, 600);
pub const TILE_LEFT: Rect = Rect::new(0, 0, 1276, 1392);
pub const TILE_RIGHT: Rect = Rect::new(1284, 0, 2560, 1392);

pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(name: &str) -> TempDir {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let dir =
            std::env::temp_dir().join(format!("nook-restore-{name}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    pub fn store(&self) -> Store {
        Store::in_dir(&self.0)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn ctx() -> Context {
    Context {
        now_ms: NOW,
        boot_time_ms: BOOT,
        ticks_ms: TICKS,
        hearth_version: Some(VERSION.to_string()),
        lock_wait: Duration::from_millis(50),
        second_pass_after: Some(Duration::ZERO),
        late_pass_after: None,
    }
}

/// Three apps' windows: Chrome and Code normal, Notes maximized. Music is minimized by the
/// user and never adopted.
pub fn world() -> FakeDesktop {
    let world = FakeDesktop::new();
    world.add_process(200, 2_000);
    world.add_process(300, 3_000);
    world.add_process(400, 4_000);
    world.add_window(CHROME, FakeWindow::new(200, "Chrome_WidgetWin_1", R_CHROME));
    world.add_window(CODE, FakeWindow::new(300, "Chrome_WidgetWin_1", R_CODE));
    world.add_window(NOTES, FakeWindow::new(400, "Notepad", R_NOTES).maximized());
    world.add_window(MUSIC, FakeWindow::new(400, "Music", R_NOTES).minimized());
    world
}

pub fn snapshot(world: &FakeDesktop) -> Vec<Option<FakeWindow>> {
    [CHROME, CODE, NOTES, MUSIC]
        .map(|h| world.window(h))
        .to_vec()
}

pub fn restorer(world: &FakeDesktop) -> FakeDesktop {
    world.handle(Mode::Restoring, "restorer")
}

/// A window manager run: its journal writer and its fenced view of the desktop.
pub struct Wm {
    pub desk: FakeDesktop,
    pub signals: FakeSignals,
    pub writer: Writer,
    pub journal: Journal,
}

impl Wm {
    pub fn start(world: &FakeDesktop, store: Store) -> Wm {
        let signals = world.signals();
        let session = "wm-session".to_string();
        let mut journal = Journal::new(VERSION, session, WM_PID, WM_START, BOOT);
        let writer = Writer::claim(store, &signals, &mut journal, CLOCK).unwrap();
        let desk = world.handle(
            Mode::Managing {
                epoch: writer.epoch(),
            },
            "wm",
        );
        Wm {
            desk,
            signals,
            writer,
            journal,
        }
    }

    pub fn save(&mut self) -> Result<(), String> {
        let journal = &mut self.journal;
        let result = self.writer.write(&self.signals, journal, CLOCK);
        result.map_err(|e| e.to_string())
    }

    fn entry(&mut self, hwnd: Hwnd) -> &mut WindowEntry {
        self.journal
            .windows
            .iter_mut()
            .find(|w| w.hwnd == hwnd)
            .unwrap()
    }

    fn bits(&self, hwnd: Hwnd) -> u32 {
        self.desk.marker(hwnd).unwrap_or(0)
    }

    /// Journal, marker, then the move into its tile.
    pub fn adopt(&mut self, hwnd: Hwnd, tile: Rect) -> Result<(), String> {
        let id = Identity::capture(&self.desk, hwnd).ok_or("gone")?;
        let original = self.desk.placement(hwnd).ok_or("gone")?;
        self.journal.windows.push(WindowEntry {
            hwnd,
            pid: id.pid,
            proc_start: id.proc_start,
            class: id.class,
            original,
            ..WindowEntry::default()
        });
        self.save()?;
        let bits = self.bits(hwnd) | marker::MANAGED;
        self.desk
            .set_marker(hwnd, bits)
            .map_err(|e| e.to_string())?;
        let tile = Placement::normal(tile).quiet();
        self.desk
            .set_placement(hwnd, &tile)
            .map_err(|e| e.to_string())
    }

    /// Journals the placement it had, then minimizes it without animation or focus.
    pub fn hide(&mut self, hwnd: Hwnd) -> Result<(), String> {
        let before = self.desk.placement(hwnd).ok_or("gone")?;
        let entry = self.entry(hwnd);
        entry.hide_placement = Some(before);
        entry.hidden = Some(Hidden::Minimized);
        entry.hidden_by = Some(HiddenBy::Nook);
        entry.transitions_disabled = true;
        self.save()?;
        let bits = self.bits(hwnd) | marker::MINIMIZED;
        let d = &self.desk;
        d.set_marker(hwnd, bits).map_err(|e| e.to_string())?;
        d.set_transitions_disabled(hwnd, true)
            .map_err(|e| e.to_string())?;
        let minimized = Placement {
            show_cmd: SW_SHOWMINNOACTIVE,
            flags: WPF_ASYNCWINDOWPLACEMENT,
            ..before
        };
        d.set_placement(hwnd, &minimized)
            .map_err(|e| e.to_string())?;
        d.set_transitions_disabled(hwnd, false)
            .map_err(|e| e.to_string())
    }

    /// Journals that the border is Nook's, then colours it.
    pub fn color(&mut self, hwnd: Hwnd, color: u32) -> Result<(), String> {
        self.entry(hwnd).border_set = true;
        self.save()?;
        let bits = self.bits(hwnd) | marker::BORDER;
        self.desk
            .set_marker(hwnd, bits)
            .map_err(|e| e.to_string())?;
        self.desk
            .set_border_color(hwnd, color)
            .map_err(|e| e.to_string())
    }
}
