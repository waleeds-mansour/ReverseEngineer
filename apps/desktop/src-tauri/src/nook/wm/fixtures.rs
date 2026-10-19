// Fixtures for the verdict tests (docs/nook-wm.md, "Testing"): what Nook saw about each window on
// the owner's PC, saved from the panel as nook\fixtures-<time>.json. A fixture holds the class,
// the styles, the owner, the cloak, the process path and its elevation, and the verdict Nook gave,
// never a title. The user profile's folder in a path becomes %USERPROFILE%. Loaded into the
// tests' probe, a file replays every verdict, so a later change to the rules shows up as a
// changed verdict against the owner's own windows.

use super::super::eligibility::Kind;
use super::super::probe::{Elevation, Hwnd, Probe, ProcessFacts, WindowFacts};
use super::state::Wm;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureProcess {
    pub path: String,
    pub elevation: Elevation,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fixture {
    pub facts: WindowFacts,
    pub cloaked: Option<u32>,
    pub process: Option<FixtureProcess>,
    /// A UWP frame's app: its pid and process.
    pub inner: Option<(u32, FixtureProcess)>,
    pub on_this_desktop: Option<bool>,
    pub verdict: String,
    pub code: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FixtureFile {
    pub version: u32,
    pub own_pid: u32,
    pub own_elevated: bool,
    pub windows: Vec<Fixture>,
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Tile => "tile",
        Kind::Float => "float",
        Kind::Ignore => "ignore",
    }
}

/// Replaces the user profile's folder at the start of a path: the whole folder only, so
/// C:\Users\Bobby keeps its name against a profile of C:\Users\Bob.
pub fn anonymize(path: &str, profile: Option<&str>) -> String {
    let p = profile.unwrap_or_default().trim_end_matches('\\');
    let starts = !p.is_empty()
        && path
            .get(..p.len())
            .is_some_and(|h| h.eq_ignore_ascii_case(p));
    match path.get(p.len()..) {
        Some(rest) if starts && (rest.is_empty() || rest.starts_with('\\')) => {
            format!("%USERPROFILE%{rest}")
        }
        _ => path.to_string(),
    }
}

fn process(p: &ProcessFacts, profile: Option<&str>) -> FixtureProcess {
    FixtureProcess {
        path: anonymize(&p.path, profile),
        elevation: p.elevation,
    }
}

pub fn capture<P: Probe>(wm: &Wm<P>, profile: Option<&str>) -> FixtureFile {
    let mut hwnds: Vec<Hwnd> = wm.windows.keys().copied().collect();
    hwnds.sort_unstable();
    let windows = hwnds
        .iter()
        .map(|h| {
            let v = &wm.windows[h].v;
            let mut facts = v.facts.clone();
            // An owner's handle means nothing elsewhere; whether there is one is what counts.
            facts.owner = Hwnd::from(facts.owner != 0);
            Fixture {
                facts,
                cloaked: v.cloaked,
                process: v.process.as_ref().map(|p| process(p, profile)),
                inner: v.inner.as_ref().map(|(pid, p)| (*pid, process(p, profile))),
                on_this_desktop: None,
                verdict: kind_name(v.kind).to_string(),
                code: v.why.code().to_string(),
            }
        })
        .collect();
    FixtureFile {
        version: VERSION,
        own_pid: wm.own.pid,
        own_elevated: wm.own.elevated,
        windows,
    }
}

/// Saves a capture to Nook's folder, named for the time it was taken.
pub fn save<P: Probe>(wm: &Wm<P>) -> Result<PathBuf, String> {
    let profile = std::env::var("USERPROFILE").ok();
    let file = capture(wm, profile.as_deref());
    let stamp = nook_restore::log::stamp(nook_restore::clock::now_ms())
        .chars()
        .filter(|c| c.is_ascii_digit())
        .take(14)
        .collect::<String>();
    std::fs::create_dir_all(&wm.dir).map_err(|e| e.to_string())?;
    let path = wm.dir.join(format!("fixtures-{stamp}.json"));
    let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
pub mod replay {
    use super::*;
    use crate::nook::eligibility::decide;
    use crate::nook::fake::{FakeProbe, FakeWindow};
    use crate::nook::probe::Own;
    use crate::nook::rules::Rules;

    /// Each fixture as a window of the tests' probe, at handle index + 1.
    pub fn probe(file: &FixtureFile) -> FakeProbe {
        let mut probe = FakeProbe::default();
        for (n, f) in file.windows.iter().enumerate() {
            let pid = f.facts.pid;
            probe.add(
                n as Hwnd + 1,
                FakeWindow {
                    facts: f.facts.clone(),
                    cloaked: f.cloaked,
                    uwp_child: f.inner.as_ref().map(|(pid, _)| *pid),
                    title: None,
                },
            );
            let as_facts = |p: &FixtureProcess| ProcessFacts {
                path: p.path.clone(),
                start: 1,
                elevation: p.elevation,
            };
            if let Some(p) = &f.process {
                probe.proc(pid, Ok(as_facts(p)));
            } else if f.code == "protected" {
                probe.proc(pid, Err(crate::nook::probe::Closed::Denied));
            }
            if let Some((inner, p)) = &f.inner {
                probe.proc(*inner, Ok(as_facts(p)));
            }
        }
        probe
    }

    /// The fixtures whose verdict differs today, as "index: was -> now".
    pub fn differences(file: &FixtureFile, rules: &Rules) -> Vec<String> {
        let probe = probe(file);
        let own = Own {
            pid: file.own_pid,
            elevated: file.own_elevated,
        };
        let mut out = Vec::new();
        for (n, f) in file.windows.iter().enumerate() {
            let now = decide(&probe, own, rules, n as Hwnd + 1, f.on_this_desktop)
                .map(|v| format!("{} {}", kind_name(v.kind), v.why.code()))
                .unwrap_or_else(|| "gone".into());
            let was = format!("{} {}", f.verdict, f.code);
            if now != was {
                out.push(format!("{n} {}: {was} -> {now}", f.facts.class));
            }
        }
        out
    }
}
