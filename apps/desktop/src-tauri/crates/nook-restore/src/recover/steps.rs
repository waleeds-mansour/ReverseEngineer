// The steps of a restore, in the design's order, and the marker sweep that stands in for a lost
// journal. Each step runs across every window before the next starts: AppBars go first because
// removing one moves the work area that placements are relative to. A hidden window is un-hidden
// and placed in one write, from a placement that keeps its maximized state, so a maximized one
// comes back maximized. A window whose restore failed keeps its journal entry and its marker, so
// the next restorer, or a sweep, still finds it and tries again.

use super::{Policy, Reason, Report};
use crate::desktop::{Desktop, DesktopError, BORDER_DEFAULT};
use crate::identity::{marker, Identity};
use crate::journal::{Hidden, HiddenBy, Journal, WindowEntry};
use crate::placement::{
    Hwnd, Placement, SW_SHOWMAXIMIZED, SW_SHOWMINIMIZED, SW_SHOWNORMAL, WPF_RESTORETOMAXIMIZED,
};

/// What the first pass wrote to one window, so the second pass can check that it landed.
pub struct Planned {
    identity: Identity,
    unhide: Option<Placement>,
    place: Option<Placement>,
    border: bool,
    transitions: bool,
    unmark: bool,
}

/// Records a write's outcome. A window that closed meanwhile has nothing left to restore, so
/// that is not a failure.
fn note(report: &mut Report, failed: &mut bool, hwnd: Hwnd, result: Result<(), DesktopError>) {
    match result {
        Ok(()) | Err(DesktopError::Gone) => {}
        Err(e) => {
            report.failed.push((hwnd, e));
            *failed = true;
        }
    }
}

/// Un-minimizes from what the window itself remembers, for when the journal has nothing better.
fn from_current(now: Placement) -> Placement {
    let show_cmd = if now.restores_maximized() {
        SW_SHOWMAXIMIZED
    } else {
        SW_SHOWNORMAL
    };
    Placement {
        flags: 0,
        show_cmd,
        ..now
    }
}

/// Step 3's placement for a window Nook minimized, and whether to write it now: the one journaled
/// when Nook hid it, so a maximized window comes back maximized. A window that doesn't read as
/// minimized yet still gets it in the plan, unwritten: Nook's minimize may wait behind a busy app
/// and land after this pass, and the second pass un-hides the window if it did. None when there
/// is nothing to undo: the window was minimized before Nook hid it, which makes it the user's.
fn unhide_target(desktop: &dyn Desktop, entry: &WindowEntry) -> Option<(Placement, bool)> {
    let now = desktop.placement(entry.hwnd)?;
    let minimized = now.is_minimized();
    match entry.hide_placement {
        Some(hidden) if hidden.is_minimized() => None,
        Some(hidden) => Some((hidden, minimized)),
        None if minimized => Some((from_current(now), true)),
        None => Some((Placement { flags: 0, ..now }, false)),
    }
}

/// Step 4's placement: the original, except that a window the user minimized stays minimized
/// and only its restore position goes back, and a window its app hid on its own is never shown.
fn original_target(
    desktop: &dyn Desktop,
    entry: &WindowEntry,
    unhidden: bool,
) -> Option<Placement> {
    let now = desktop.placement(entry.hwnd)?;
    if !unhidden && !desktop.is_visible(entry.hwnd) {
        return None;
    }
    let mut target = entry.original;
    if !unhidden && now.is_minimized() && !target.is_minimized() {
        target.flags &= !WPF_RESTORETOMAXIMIZED;
        if target.is_maximized() {
            target.flags |= WPF_RESTORETOMAXIMIZED;
        }
        target.show_cmd = SW_SHOWMINIMIZED;
    }
    Some(target)
}

/// The entry owes nothing more: it was put back, or its window is gone or someone else's.
fn settle(entry: &mut WindowEntry) {
    entry.hidden = None;
    entry.hidden_by = None;
    entry.border_set = false;
    entry.transitions_disabled = false;
}

/// Steps 1 to 6 over the windows whose identity still matches. Returns what it wrote, for the
/// second pass, and marks each restored window's entry as owing nothing more.
pub fn first_pass(
    desktop: &dyn Desktop,
    journal: &mut Journal,
    policy: Policy,
    reason: Reason,
    report: &mut Report,
) -> Vec<Planned> {
    let session_end = reason == Reason::SessionEnd;
    let mut nobody = false;
    for bar in &journal.appbars {
        if desktop.is_window(bar.hwnd) {
            note(
                report,
                &mut nobody,
                bar.hwnd,
                desktop.remove_appbar(bar.hwnd),
            );
        }
    }

    let mut live = Vec::new();
    for (index, entry) in journal.windows.iter_mut().enumerate() {
        match Identity::of(entry).verify(desktop) {
            Ok(()) => live.push(index),
            Err(_) => {
                // Nothing can be put back on a window that is gone or now someone else's.
                report.skipped += 1;
                settle(entry);
            }
        }
    }
    let mut failed = vec![false; live.len()];
    let mut plans: Vec<Planned> = live
        .iter()
        .map(|&i| {
            let entry = &journal.windows[i];
            Planned {
                identity: Identity::of(entry),
                unhide: None,
                place: None,
                border: entry.border_set,
                transitions: entry.transitions_disabled,
                unmark: !session_end,
            }
        })
        .collect();

    for (k, &i) in live.iter().enumerate() {
        let entry = &journal.windows[i];
        if entry.hidden == Some(Hidden::Cloaked) && entry.hidden_by == Some(HiddenBy::Nook) {
            note(
                report,
                &mut failed[k],
                entry.hwnd,
                desktop.uncloak(entry.hwnd),
            );
        }
    }
    // Un-hiding and placing are one write per window. A placement posted right behind an
    // un-minimize is lost most of the time: Windows finishes the un-minimize after the second
    // write and puts back the rectangle the first one named (16 of 20 tries with real windows on
    // a private desktop). So a window Nook hid goes from minimized straight to where it belongs,
    // and the second pass only has late writes from elsewhere left to catch.
    let originals = policy == Policy::Originals && !session_end;
    for (k, &i) in live.iter().enumerate() {
        let entry = &journal.windows[i];
        let h = entry.hwnd;
        let by_app = entry.hidden_by == Some(HiddenBy::AppAfterNook);
        let unhide = match (entry.hidden, entry.hidden_by) {
            (Some(Hidden::Minimized), Some(HiddenBy::Nook)) => unhide_target(desktop, entry),
            _ => None,
        };
        let unhide_now = unhide.filter(|&(_, now)| now).map(|(target, _)| target);
        let unhidden = unhide_now.is_some() || by_app;
        let place = if originals {
            original_target(desktop, entry, unhidden)
        } else {
            None
        };
        plans[k].unhide = unhide.map(|(target, _)| target);
        plans[k].place = place;
        // SetWindowPlacement shows a window as it places it, so the tray app's window needs the
        // separate show only when nothing is placed.
        let result = match (place.or(unhide_now), by_app) {
            (Some(target), _) => desktop.set_placement(h, &target.quiet()),
            (None, true) => desktop.show_no_activate(h),
            (None, false) => continue,
        };
        note(report, &mut failed[k], h, result);
    }
    for (k, plan) in plans.iter().enumerate() {
        let h = plan.identity.hwnd;
        if plan.border {
            let result = desktop.set_border_color(h, BORDER_DEFAULT);
            note(report, &mut failed[k], h, result);
        }
        if plan.transitions {
            let result = desktop.set_transitions_disabled(h, false);
            note(report, &mut failed[k], h, result);
        }
    }
    for (k, plan) in plans.iter_mut().enumerate() {
        let h = plan.identity.hwnd;
        // A window whose restore failed keeps its marker, so a sweep can still find it.
        if failed[k] {
            plan.unmark = false;
        } else if plan.unmark && desktop.marker(h).is_some() {
            note(report, &mut failed[k], h, desktop.remove_marker(h));
        }
    }

    for (k, &i) in live.iter().enumerate() {
        if !failed[k] {
            report.restored += 1;
            settle(&mut journal.windows[i]);
        }
    }
    plans
}

/// Step 8, a second after the first pass: whatever an earlier asynchronous write moved after the
/// restore (a stalled window manager's move landing late) is put right again.
pub fn second_pass(desktop: &dyn Desktop, plans: &[Planned], report: &mut Report) -> usize {
    let mut fixes = 0;
    for plan in plans {
        if plan.identity.verify(desktop).is_err() {
            continue;
        }
        let h = plan.identity.hwnd;
        let Some(now) = desktop.placement(h) else {
            continue;
        };
        let mut failed = false;
        // A window its app hid in the meantime stays hidden; a minimized one is still visible.
        let shown = desktop.is_visible(h);
        let redo = match (plan.place, plan.unhide) {
            _ if !shown => None,
            (Some(target), _) => {
                let moved = now.normal_position != target.normal_position;
                let state = !target.is_minimized() && now.shown() != target.shown();
                (moved || state).then_some(target)
            }
            (None, Some(target)) => now.is_minimized().then_some(target),
            (None, None) => None,
        };
        if let Some(target) = redo {
            fixes += 1;
            note(
                report,
                &mut failed,
                h,
                desktop.set_placement(h, &target.quiet()),
            );
        }
        // DWM can't report another app's border colour, so these are set again rather than read.
        if plan.border {
            note(
                report,
                &mut failed,
                h,
                desktop.set_border_color(h, BORDER_DEFAULT),
            );
        }
        if plan.transitions {
            note(
                report,
                &mut failed,
                h,
                desktop.set_transitions_disabled(h, false),
            );
        }
        if plan.unmark && desktop.marker(h).is_some() {
            fixes += 1;
            note(report, &mut failed, h, desktop.remove_marker(h));
        }
    }
    fixes
}

/// The restore without a usable journal: every window carrying Nook's marker gets back what the
/// marker says Nook did to it. Positions can't be restored (the originals were in the journal),
/// but no window stays minimized, cloaked or coloured by Nook. A window it couldn't put back
/// keeps its marker and comes back as a journal entry, so the next restorer tries again.
pub fn sweep(desktop: &dyn Desktop, report: &mut Report) -> Vec<WindowEntry> {
    let marked = desktop.marked();
    let mut failed = vec![false; marked.len()];
    let has = |bits: u32, bit: u32| bits & bit != 0;
    for (k, &(h, bits)) in marked.iter().enumerate() {
        if has(bits, marker::CLOAKED) {
            note(report, &mut failed[k], h, desktop.uncloak(h));
        }
    }
    for (k, &(h, bits)) in marked.iter().enumerate() {
        let now = desktop.placement(h).filter(|p| p.is_minimized());
        if let (true, Some(now)) = (has(bits, marker::MINIMIZED), now) {
            let result = desktop.set_placement(h, &from_current(now).quiet());
            note(report, &mut failed[k], h, result);
        }
    }
    for (k, &(h, bits)) in marked.iter().enumerate() {
        if has(bits, marker::BORDER) {
            note(
                report,
                &mut failed[k],
                h,
                desktop.set_border_color(h, BORDER_DEFAULT),
            );
        }
        if has(bits, marker::MINIMIZED) {
            note(
                report,
                &mut failed[k],
                h,
                desktop.set_transitions_disabled(h, false),
            );
        }
    }
    let mut owed = Vec::new();
    for (k, &(h, bits)) in marked.iter().enumerate() {
        if failed[k] {
            owed.extend(entry_from_marker(desktop, h, bits));
        } else {
            note(report, &mut failed[k], h, desktop.remove_marker(h));
        }
    }
    report.restored += failed.iter().filter(|f| !**f).count();
    report.swept = Some(marked.len());
    owed
}

/// A journal entry for a marked window the sweep couldn't put back, from what its marker says.
/// The real original was in the lost journal, so the entry's original is where the window is now;
/// trying again keeps positions anyway (Reason::Retry's policy), so it only un-hides and resets.
fn entry_from_marker(desktop: &dyn Desktop, hwnd: Hwnd, bits: u32) -> Option<WindowEntry> {
    let id = Identity::capture(desktop, hwnd)?;
    let now = desktop.placement(hwnd)?;
    let has = |bit: u32| bits & bit != 0;
    let hidden = if has(marker::CLOAKED) {
        Some(Hidden::Cloaked)
    } else if has(marker::MINIMIZED) {
        Some(Hidden::Minimized)
    } else {
        None
    };
    Some(WindowEntry {
        hwnd,
        pid: id.pid,
        proc_start: id.proc_start,
        class: id.class,
        original: if now.is_minimized() {
            from_current(now)
        } else {
            now
        },
        hidden,
        hidden_by: hidden.map(|_| HiddenBy::Nook),
        border_set: has(marker::BORDER),
        transitions_disabled: has(marker::MINIMIZED),
        ..WindowEntry::default()
    })
}
