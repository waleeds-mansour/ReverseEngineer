// nook-wm's state (docs/nook-wm.md, "STATE OWNERSHIP" and "FLUSH"). Only nook-wm's thread holds a
// Wm, and everything else sends it commands. A flush applies one batch of coalesced events in the
// design's order: destroy, show and uncloak, cloak and hide, minimize, move, location, then the
// foreground. In Observing mode a flush only updates verdicts, the focus and the gates; a pass
// the gates would allow is counted, never run, and every write would go through the seam, which
// refuses it.

use super::super::coalesce::{bit, global, Batch};
use super::super::eligibility::{decide, Stage, Verdict};
use super::super::game::{QunsCache, Tripped};
use super::super::gates::Gates;
use super::super::monitors::Monitor;
use super::super::probe::{exe_of, Hwnd, Own, Probe};
use super::super::rules::Rules;
use super::super::seam::Writer;
use super::super::vd::Asked;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::PathBuf;
use std::time::Instant;

/// With the panel closed, Nook keeps verdicts for this many recently focused windows only:
/// nothing tells it when the others go.
pub const KEEP_CLOSED: usize = 64;

pub struct Win {
    pub v: Verdict,
    pub app: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Stats {
    pub verdicts: u64,
    pub process_opens: u64,
    pub enumerations: u64,
    /// Layout passes the gates would have let an arranging Nook run.
    pub passes_observed: u64,
    pub settles: u64,
    pub put_backs: u64,
    pub unhide_alls: u64,
    pub alt_tabs: u64,
    pub desktop_switches: u64,
    pub vd_answers: u64,
    pub shell_signals: u64,
    pub flushes: u64,
    /// Flushes after the callback's map was full.
    pub overflows: u64,
    pub gate_trips: BTreeMap<&'static str, u64>,
}

pub struct Wm<P: Probe> {
    pub probe: P,
    pub own: Own,
    pub rules: Rules,
    pub dir: PathBuf,
    pub windows: HashMap<Hwnd, Win>,
    pub(super) recent: VecDeque<Hwnd>,
    pub monitors: Vec<Monitor>,
    /// The monitors Nook arranges, by stable id: the primary one when observing began.
    pub watched: Vec<String>,
    pub gates: Gates,
    pub game: Option<Tripped>,
    pub(super) quns: QunsCache,
    pub focused: Option<Hwnd>,
    pub panel_open: bool,
    pub observe_setting: bool,
    /// The bar's seam: F1 follows the foreground app so a window going fullscreen is seen.
    pub follow_foreground: bool,
    /// The bar's and popover's windows. A click on one brings it to the front for a moment
    /// before it hands the foreground back, and what was in front stays in front meanwhile.
    pub chrome: Vec<Hwnd>,
    pub(super) vd: HashMap<Hwnd, Option<bool>>,
    pub(super) vd_asked: Asked,
    pub(super) vd_queue: Vec<Hwnd>,
    pub(super) names: HashMap<String, String>,
    pub writer: Writer,
    pub stats: Stats,
    pub(super) known_added: Vec<Hwnd>,
    pub(super) known_removed: Vec<Hwnd>,
    /// Something a page shows changed since the last publish.
    pub changed: bool,
}

impl<P: Probe> Wm<P> {
    pub fn new(probe: P, own: Own, dir: PathBuf, now: Instant) -> Wm<P> {
        let rules = Rules::load(&dir);
        let monitors = probe.monitors();
        let watched = monitors
            .iter()
            .filter(|m| m.managed())
            .map(|m| m.id.clone())
            .collect();
        let mut wm = Wm {
            probe,
            own,
            rules,
            dir,
            windows: HashMap::new(),
            recent: VecDeque::new(),
            monitors,
            watched,
            gates: Gates::default(),
            game: None,
            quns: QunsCache::default(),
            focused: None,
            panel_open: false,
            observe_setting: false,
            follow_foreground: false,
            chrome: Vec::new(),
            vd: HashMap::new(),
            vd_asked: Asked::default(),
            vd_queue: Vec::new(),
            names: HashMap::new(),
            writer: Writer::observing(),
            stats: Stats::default(),
            known_added: Vec::new(),
            known_removed: Vec::new(),
            changed: true,
        };
        if wm.probe.remote_session() {
            let acts = wm.gates.remote_connected();
            wm.act(acts, now);
        }
        if let Some(front) = wm.probe.foreground() {
            wm.foreground(front, now);
        }
        wm.judge_game(now);
        wm
    }

    /// One flush.
    pub fn apply(&mut self, batch: &Batch, now: Instant) {
        self.stats.flushes += 1;
        let mut look_at_game = false;
        for &(h, d) in &batch.windows {
            if d.bits & bit::DESTROYED != 0 {
                self.forget(h);
                continue;
            }
            let known = self.windows.contains_key(&h);
            if d.bits & (bit::SHOWN | bit::UNCLOAKED) != 0 {
                // Some apps change their style after creating the window, and an uncloaked
                // window may have moved desktops: judge it again from Stage A.
                self.vd.remove(&h);
                if known || self.top_level(h) {
                    self.judge(h);
                }
            } else if known && d.bits & (bit::CLOAKED | bit::HIDDEN) != 0 {
                self.vd.remove(&h);
                self.judge(h);
            }
            let moved = bit::MIN_START | bit::MIN_END | bit::MOVE_END | bit::LOCATED;
            if d.bits & moved != 0 {
                self.refresh_geometry(h);
                look_at_game |= Some(h) == self.focused;
            }
        }
        if let Some(front) = batch.foreground {
            self.foreground(front, now);
            look_at_game = true;
        }
        // Events about some windows were dropped: look again at what they could have hidden.
        if batch.overflowed {
            self.stats.overflows += 1;
            if self.panel_open {
                self.enumerate();
            } else if let Some(h) = self.focused {
                self.refresh_geometry(h);
            }
            look_at_game = true;
        }
        if batch.global & global::DESKTOP_SWITCH != 0 {
            self.stats.desktop_switches += 1;
            let locked = !self.probe.input_desktop_ours();
            if locked != self.gates.session_locked {
                let acts = self.gates.lock(locked, now);
                self.log_gate("session_locked", locked);
                self.act(acts, now);
            }
        }
        if batch.global & global::SWITCH_END != 0 {
            self.stats.alt_tabs += 1;
        }
        if look_at_game {
            self.judge_game(now);
        }
        if !self.panel_open {
            self.prune();
        }
    }

    /// Whether a window Nook hasn't seen is worth judging. With the panel open every window's
    /// SHOW arrives, child windows', tooltips' and menus' too, and those would only fill the list.
    fn top_level(&self, h: Hwnd) -> bool {
        use super::super::probe::style::WS_CHILD;
        const PASSING: [&str; 2] = ["tooltips_class32", "#32768"];
        self.probe.window(h).is_some_and(|f| {
            f.root
                && f.style & WS_CHILD == 0
                && !PASSING.iter().any(|c| c.eq_ignore_ascii_case(&f.class))
        })
    }

    /// The staged verdict for one window, kept in the cache.
    pub fn judge(&mut self, h: Hwnd) -> Option<&Win> {
        let on_this_desktop = self.vd.get(&h).copied().flatten();
        let Some(v) = decide(&self.probe, self.own, &self.rules, h, on_this_desktop) else {
            self.forget(h);
            return None;
        };
        self.stats.verdicts += 1;
        self.stats.process_opens += u64::from(v.opened);
        // Once each: while nook-com is stuck, a window judged again isn't queued again.
        if v.stage >= Stage::D && !self.vd.contains_key(&h) && !self.vd_queue.contains(&h) {
            self.vd_queue.push(h);
        }
        let app = self.app_name(&v);
        if self.windows.insert(h, Win { v, app }).is_none() {
            self.known_added.push(h);
        }
        self.changed = true;
        self.windows.get(&h)
    }

    fn app_name(&mut self, v: &Verdict) -> String {
        let Some(path) = v.app_path() else {
            return String::new();
        };
        if let Some(name) = self.names.get(path) {
            return name.clone();
        }
        let exe = exe_of(path);
        let name = self.probe.description(path).unwrap_or_else(|| {
            exe.strip_suffix(".exe")
                .or_else(|| exe.strip_suffix(".EXE"))
                .unwrap_or(exe)
                .to_string()
        });
        self.names.insert(path.to_string(), name.clone());
        name
    }

    /// Remembers `h` as recently focused.
    pub(super) fn touch(&mut self, h: Hwnd) {
        self.recent.retain(|&x| x != h);
        self.recent.push_back(h);
        while self.recent.len() > KEEP_CLOSED {
            self.recent.pop_front();
        }
    }

    pub fn forget(&mut self, h: Hwnd) {
        if self.windows.remove(&h).is_some() {
            self.known_removed.push(h);
            self.changed = true;
        }
        self.recent.retain(|&x| x != h);
        self.vd.remove(&h);
        if self.focused == Some(h) {
            self.focused = None;
        }
    }

    /// Keeps the recently focused windows only, while nothing reports the others going.
    pub(super) fn prune(&mut self) {
        let stray: Vec<Hwnd> = self
            .windows
            .keys()
            .copied()
            .filter(|h| !self.recent.contains(h) && Some(*h) != self.focused)
            .collect();
        stray.into_iter().for_each(|h| self.forget(h));
    }

    /// A window moved, resized, or was minimized or restored. Going fullscreen in place (a
    /// video's "f", F11) also drops the title bar, which the game guard reads, so the styles are
    /// taken too, and a window whose verdict no longer fits is judged again.
    fn refresh_geometry(&mut self, h: Hwnd) {
        let Some(win) = self.windows.get_mut(&h) else {
            return;
        };
        match self.probe.window(h) {
            Some(f) if same_window(&win.v.facts, &f) => {
                win.v.facts = f;
                self.changed = true;
            }
            Some(_) => {
                self.judge(h);
            }
            None => self.forget(h),
        }
    }

    /// The foreground moved. A cached verdict is kept when the window still looks the same, so
    /// Alt-Tab between known windows opens no process.
    pub fn foreground(&mut self, h: Hwnd, _now: Instant) {
        if self.chrome.contains(&h) {
            return;
        }
        self.focused = Some(h);
        self.changed = true;
        let Some(fresh) = self.probe.window(h) else {
            self.forget(h);
            return;
        };
        match self.windows.get_mut(&h) {
            Some(win) if same_window(&win.v.facts, &fresh) => win.v.facts = fresh,
            _ => {
                self.judge(h);
            }
        }
        self.touch(h);
    }

    /// Every top-level window, judged afresh: when the panel opens or asks, and at settle end
    /// while it is open.
    pub fn enumerate(&mut self) {
        self.stats.enumerations += 1;
        let now: Vec<Hwnd> = self.probe.top_level();
        let gone: Vec<Hwnd> = self
            .windows
            .keys()
            .copied()
            .filter(|h| !now.contains(h))
            .collect();
        gone.into_iter().for_each(|h| self.forget(h));
        for h in now {
            self.judge(h);
        }
    }

    pub fn set_panel(&mut self, open: bool) {
        self.panel_open = open;
        self.changed = true;
        if open {
            self.enumerate();
        } else {
            self.prune();
        }
    }
}

/// Whether a cached verdict still fits the window: same process and class, and none of the
/// styles the verdict reads changed.
fn same_window(
    old: &super::super::probe::WindowFacts,
    new: &super::super::probe::WindowFacts,
) -> bool {
    use super::super::probe::style::*;
    let styles = WS_CHILD | WS_POPUP | WS_DISABLED | WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZEBOX;
    let ex = WS_EX_TOOLWINDOW
        | WS_EX_APPWINDOW
        | WS_EX_NOACTIVATE
        | WS_EX_LAYERED
        | WS_EX_TRANSPARENT
        | WS_EX_TOPMOST;
    old.pid == new.pid
        && old.class == new.class
        && old.style & styles == new.style & styles
        && old.ex_style & ex == new.ex_style & ex
        && old.visible == new.visible
        && (old.owner == 0) == (new.owner == 0)
}
