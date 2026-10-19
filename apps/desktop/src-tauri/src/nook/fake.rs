// A probe that answers from tables, for the verdict and state tests. It counts every process it
// is asked to open and every title it is asked to read, so a test can prove the staged order.

use super::monitors::Monitor;
use super::probe::style::*;
use super::probe::{Closed, Hwnd, Probe, ProcessFacts, Rect, WindowFacts};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

#[derive(Clone, Debug, Default)]
pub struct FakeWindow {
    pub facts: WindowFacts,
    pub cloaked: Option<u32>,
    pub uwp_child: Option<u32>,
    pub title: Option<String>,
}

#[derive(Default)]
pub struct FakeProbe {
    pub windows: HashMap<Hwnd, FakeWindow>,
    pub processes: HashMap<u32, Result<ProcessFacts, Closed>>,
    pub descriptions: HashMap<String, String>,
    pub screens: RefCell<Vec<Monitor>>,
    pub front: Cell<Option<Hwnd>>,
    pub quns: Cell<i32>,
    pub secure_desktop: Cell<bool>,
    pub remote: Cell<bool>,
    pub opened: RefCell<Vec<u32>>,
    pub titles_read: Cell<usize>,
}

/// An ordinary app window: shown, captioned, sizable, its own Alt-Tab root, 800 by 600.
pub fn app_window(class: &str, pid: u32) -> FakeWindow {
    FakeWindow {
        facts: WindowFacts {
            class: class.to_string(),
            pid,
            style: WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | 0x1000_0000,
            ex_style: 0x100,
            visible: true,
            root: true,
            owner: 0,
            alt_tab_root: true,
            rect: Rect {
                left: 100,
                top: 100,
                right: 900,
                bottom: 700,
            },
            iconic: false,
            zoomed: false,
        },
        cloaked: Some(0),
        uwp_child: None,
        title: None,
    }
}

pub fn process(path: &str) -> ProcessFacts {
    ProcessFacts {
        path: path.to_string(),
        start: 1,
        elevation: super::probe::Elevation::No,
    }
}

impl FakeProbe {
    pub fn add(&mut self, hwnd: Hwnd, window: FakeWindow) -> &mut Self {
        self.windows.insert(hwnd, window);
        self
    }

    pub fn proc(&mut self, pid: u32, facts: Result<ProcessFacts, Closed>) -> &mut Self {
        self.processes.insert(pid, facts);
        self
    }

    pub fn opens(&self) -> usize {
        self.opened.borrow().len()
    }
}

impl Probe for FakeProbe {
    fn window(&self, hwnd: Hwnd) -> Option<WindowFacts> {
        self.windows.get(&hwnd).map(|w| w.facts.clone())
    }

    fn cloaked(&self, hwnd: Hwnd) -> Option<u32> {
        self.windows.get(&hwnd).and_then(|w| w.cloaked)
    }

    fn process(&self, pid: u32) -> Result<ProcessFacts, Closed> {
        self.opened.borrow_mut().push(pid);
        self.processes
            .get(&pid)
            .cloned()
            .unwrap_or(Err(Closed::Gone))
    }

    fn uwp_child_pid(&self, frame: Hwnd) -> Option<u32> {
        self.windows.get(&frame).and_then(|w| w.uwp_child)
    }

    fn title(&self, hwnd: Hwnd) -> Option<String> {
        self.titles_read.set(self.titles_read.get() + 1);
        self.windows.get(&hwnd).and_then(|w| w.title.clone())
    }

    fn monitors(&self) -> Vec<Monitor> {
        self.screens.borrow().clone()
    }

    fn top_level(&self) -> Vec<Hwnd> {
        let mut all: Vec<Hwnd> = self.windows.keys().copied().collect();
        all.sort_unstable();
        all
    }

    fn foreground(&self) -> Option<Hwnd> {
        self.front.get()
    }

    fn notification_state(&self) -> Option<i32> {
        Some(self.quns.get())
    }

    fn input_desktop_ours(&self) -> bool {
        !self.secure_desktop.get()
    }

    fn remote_session(&self) -> bool {
        self.remote.get()
    }

    fn description(&self, path: &str) -> Option<String> {
        self.descriptions.get(path).cloned()
    }
}

/// The owner's PC as the design describes it: a 2560x1440 primary and an ultrawide beside it.
pub fn two_monitors() -> Vec<Monitor> {
    let screen = |id: &str, name: &str, left, right, primary| Monitor {
        id: id.to_string(),
        name: name.to_string(),
        rect: Rect {
            left,
            top: 0,
            right,
            bottom: 1440,
        },
        work: Rect {
            left,
            top: 0,
            right,
            bottom: 1392,
        },
        dpi: 96,
        primary,
    };
    vec![
        screen(r"\\?\DISPLAY#ONE", "DISPLAY1", 0, 2560, true),
        screen(r"\\?\DISPLAY#TWO", "DISPLAY2", 2560, 6000, false),
    ]
}
