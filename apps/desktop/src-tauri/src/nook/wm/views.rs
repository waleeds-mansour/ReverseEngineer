// NookState from nook-wm's state (docs/nook-wm.md, "WHY NOT TILED" and "DATA FOR THE BAR"): the
// monitors, the app in front, the gates that are set, the write counts, and, for the panel, every
// window with its verdict and the first reason Nook wouldn't arrange it.

use super::super::eligibility::{shell_class, Kind, Verdict};
use super::super::monitors::{holding, Monitor};
use super::super::probe::{Elevation, Hwnd, Probe, Rect};
use super::super::view::{
    FocusedView, FrontWindow, GateView, ModeName, MonitorView, NookState, RectView, VerdictName,
    WindowState, WindowView,
};
use super::state::{Win, Wm};
use std::time::Instant;

pub fn rect(r: &Rect) -> RectView {
    RectView {
        x: r.left,
        y: r.top,
        width: r.width(),
        height: r.height(),
    }
}

pub fn verdict(kind: Kind) -> VerdictName {
    match kind {
        Kind::Tile => VerdictName::Tile,
        Kind::Float => VerdictName::Float,
        Kind::Ignore => VerdictName::Ignore,
    }
}

pub fn monitor(m: &Monitor, watched: &[String]) -> MonitorView {
    let managed = m.managed() && watched.contains(&m.id);
    MonitorView {
        id: m.id.clone(),
        name: m.name.clone(),
        rect: rect(&m.rect),
        work: rect(&m.work),
        dpi: m.dpi,
        primary: m.primary,
        managed,
        note: if m.managed() && !managed {
            "Stayed away, so Nook stopped arranging it until observing starts again".into()
        } else {
            m.note().into()
        },
    }
}

fn gate_text(name: &str) -> &'static str {
    match name {
        "user_paused" => "Paused by you",
        "game_guard" => "A game or something fullscreen is in front",
        "session_locked" => "The PC is locked, or Windows is asking for permission",
        "settling" => "Waiting for Windows to finish changing the displays",
        "display_missing" => "A monitor Nook arranges is missing",
        "remote_session" => "A remote session is connected",
        "journal_failed" => "Nook couldn't write its journal",
        "breaker" => "Too many unexpected moves, so Nook paused",
        "revoked" => "A restore took over",
        _ => "",
    }
}

fn state_of(v: &Verdict) -> WindowState {
    if v.facts.iconic {
        WindowState::Minimized
    } else if v.facts.zoomed {
        WindowState::Maximized
    } else {
        WindowState::Normal
    }
}

/// The reason the panel shows: the verdict's own, or for a window Nook could arrange, why it
/// would still be left where it is.
pub fn why(win: &Win, monitors: &[Monitor], watched: &[String]) -> String {
    let v = &win.v;
    if v.kind != Kind::Tile {
        return v.why.text();
    }
    match state_of(v) {
        WindowState::Minimized => return "Minimized by you: left as it is".into(),
        WindowState::Maximized => return "Maximized by you: left as it is".into(),
        WindowState::Normal => {}
    }
    match holding(monitors, &v.facts.rect) {
        Some(m) if !(m.managed() && watched.contains(&m.id)) => {
            format!("On {}, which Nook leaves alone", m.name)
        }
        _ => v.why.text(),
    }
}

fn window(hwnd: isize, win: &Win, monitors: &[Monitor], watched: &[String]) -> WindowView {
    let v = &win.v;
    WindowView {
        id: format!("{:#x}", hwnd as usize),
        app: win.app.clone(),
        exe: v.exe.clone(),
        class: v.facts.class.clone(),
        verdict: verdict(v.kind),
        why: why(win, monitors, watched),
        code: v.why.code().to_string(),
        state: state_of(v),
        monitor: holding(monitors, &v.facts.rect).map(|m| m.name.clone()),
        sticky: v.flags.contains(&super::super::rules::Flag::NoHide),
    }
}

pub fn state<P: Probe>(wm: &Wm<P>, now: Instant, seq: u64) -> NookState {
    let focused = wm
        .focused
        .and_then(|h| wm.windows.get(&h))
        .map(|w| FocusedView {
            app: if w.app.is_empty() {
                w.v.facts.class.clone()
            } else {
                w.app.clone()
            },
            exe: w.v.exe.clone(),
            verdict: verdict(w.v.kind),
            why: why(w, &wm.monitors, &wm.watched),
            game: wm.game.is_some(),
        });
    let gates = wm
        .gates
        .names(now)
        .into_iter()
        .map(|name| GateView {
            name: name.to_string(),
            text: match (name, wm.game) {
                ("game_guard", Some(t)) => t.text().to_string(),
                _ => gate_text(name).to_string(),
            },
        })
        .collect();
    let mut windows: Vec<WindowView> = if wm.panel_open {
        wm.windows
            .iter()
            .map(|(&h, w)| window(h, w, &wm.monitors, &wm.watched))
            .collect()
    } else {
        Vec::new()
    };
    let rank = |v: VerdictName| match v {
        VerdictName::Tile => 0,
        VerdictName::Float => 1,
        VerdictName::Ignore => 2,
    };
    windows.sort_by(|a, b| {
        (rank(a.verdict), a.app.to_lowercase(), &a.class, &a.id).cmp(&(
            rank(b.verdict),
            b.app.to_lowercase(),
            &b.class,
            &b.id,
        ))
    });
    let mut problems = wm.rules.problems.clone();
    if wm.vd_stuck() {
        problems.push("Windows' virtual desktop service isn't answering".into());
    }
    NookState {
        seq,
        mode: ModeName::Observing,
        why_off: None,
        observe: wm.observe_setting,
        panel_open: wm.panel_open,
        elevated: wm.own.elevated,
        monitors: wm
            .monitors
            .iter()
            .map(|m| monitor(m, &wm.watched))
            .collect(),
        focused,
        gates,
        writes: wm.writer.counts(),
        windows,
        problems,
        front: wm
            .focused
            .and_then(|h| wm.windows.get(&h).map(|w| front(h, w, wm))),
    }
}

/// The window in front as the bar needs it. The foreground hook hears Hearth's own windows too
/// (hooks.rs), so one of them can be in front here, and the bar then hands the foreground back to
/// it rather than to a window from before it; the bar's own two windows it leaves out itself.
fn front<P: Probe>(h: Hwnd, w: &Win, wm: &Wm<P>) -> FrontWindow {
    let f = &w.v.facts;
    let elevated = if f.pid == wm.own.pid {
        Some(wm.own.elevated)
    } else {
        w.v.process.as_ref().and_then(|p| match p.elevation {
            Elevation::Yes => Some(true),
            Elevation::No => Some(false),
            Elevation::Unknown => None,
        })
    };
    FrontWindow {
        hwnd: h,
        pid: f.pid,
        rect: (!shell_class(&f.class)).then(|| rect(&f.rect)),
        monitor: holding(&wm.monitors, &f.rect).map(|m| rect(&m.rect)),
        elevated,
        on_this_desktop: wm.vd.get(&h).copied().flatten(),
        game: wm.game.is_some(),
    }
}
