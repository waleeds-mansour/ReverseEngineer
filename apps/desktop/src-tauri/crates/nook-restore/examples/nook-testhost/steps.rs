// The window manager's writes, one step at a time, in the design's write-ahead order: the journal
// first, then the marker, then the change itself. A kill between any two steps must leave
// nothing that a restorer can't put back.

use nook_restore::desktop::{Desktop, DesktopError};
use nook_restore::identity::{marker, Identity};
use nook_restore::journal::{Hidden, HiddenBy, WindowEntry, WriteError};
use nook_restore::placement::{Hwnd, Placement, Rect, SW_SHOWMINNOACTIVE, WPF_RESTORETOMAXIMIZED};

/// The border colour the host draws (a COLORREF, 0x00BBGGRR): an orange no test window has.
pub const BORDER: u32 = 0x0000_88FF;

#[derive(Clone, Copy, Debug)]
pub enum Step {
    /// Takes over the journal (its first write).
    Claim,
    /// Tells the guard something is journaled.
    Arm,
    /// Journals the window's identity and original placement.
    Adopt(usize),
    /// Adds bits to the window's marker.
    Mark(usize, u32),
    /// Journals where the window is about to be moved.
    PlanMove(usize, Rect),
    Move(usize, Rect),
    /// Journals that the window is about to get a border colour.
    PlanBorder(usize),
    Border(usize),
    /// Journals the placement the window is about to be hidden from.
    PlanHide(usize),
    /// Minimizes the window, remembering whether it comes back maximized.
    Hide(usize),
}

impl Step {
    pub fn label(&self) -> &'static str {
        match self {
            Step::Claim => "claim",
            Step::Arm => "arm",
            Step::Adopt(_) => "adopt",
            Step::Mark(..) => "mark",
            Step::PlanMove(..) => "journal-move",
            Step::Move(..) => "move",
            Step::PlanBorder(_) => "journal-border",
            Step::Border(_) => "border",
            Step::PlanHide(_) => "journal-hide",
            Step::Hide(_) => "hide",
        }
    }
}

/// The tile a normal window is moved to: a column of its own, away from where it started.
pub fn tile(i: usize) -> Rect {
    let left = 8 + 420 * i as i32;
    Rect::new(left, 8, left + 412, 700)
}

/// Adopt, move, border and hide, over every test window. The last window is never hidden, so
/// one window stays visible and bordered the whole time, as most of a real layout does.
pub fn plan(maximized: &[bool]) -> Vec<Step> {
    let n = maximized.len();
    let mut steps = vec![Step::Claim, Step::Arm];
    for i in 0..n {
        steps.push(Step::Adopt(i));
        steps.push(Step::Mark(i, marker::MANAGED));
    }
    for (i, _) in maximized.iter().enumerate().filter(|(_, max)| !**max) {
        steps.push(Step::PlanMove(i, tile(i)));
        steps.push(Step::Move(i, tile(i)));
    }
    for i in 0..n {
        steps.push(Step::PlanBorder(i));
        steps.push(Step::Mark(i, marker::BORDER));
        steps.push(Step::Border(i));
    }
    for i in 0..n.saturating_sub(1) {
        steps.push(Step::PlanHide(i));
        steps.push(Step::Mark(i, marker::MINIMIZED));
        steps.push(Step::Hide(i));
    }
    steps
}

/// Every change once more, as a window manager resuming a pass would make it.
pub fn again(maximized: &[bool]) -> Vec<Step> {
    let mut steps = Vec::new();
    for (i, max) in maximized.iter().enumerate() {
        steps.push(Step::Mark(
            i,
            marker::MANAGED | marker::BORDER | marker::MINIMIZED,
        ));
        if !max {
            steps.push(Step::Move(i, tile(i)));
        }
        steps.push(Step::Border(i));
        steps.push(Step::PlanHide(i));
        steps.push(Step::Hide(i));
    }
    steps
}

/// Why a step didn't happen.
pub enum Fail {
    /// The writer was revoked: the step was refused before it reached Windows.
    Refused,
    Other(String),
}

pub fn desktop_fail(e: DesktopError) -> Fail {
    match e {
        DesktopError::Revoked | DesktopError::ReadOnly => Fail::Refused,
        e => Fail::Other(e.to_string()),
    }
}

pub fn journal_fail(e: WriteError) -> Fail {
    match e {
        WriteError::Revoked | WriteError::Stale { .. } => Fail::Refused,
        e => Fail::Other(e.to_string()),
    }
}

/// The journal entry for a window being adopted, read from the window as it is now.
pub fn entry_for(reader: &dyn Desktop, hwnd: Hwnd) -> Result<WindowEntry, Fail> {
    let id = Identity::capture(reader, hwnd).ok_or(Fail::Other("can't read the window".into()))?;
    let original = reader
        .placement(hwnd)
        .ok_or(Fail::Other("can't read the placement".into()))?;
    Ok(WindowEntry {
        hwnd,
        pid: id.pid,
        proc_start: id.proc_start,
        exe: "nook-testwin.exe".into(),
        class: id.class,
        original,
        user_maximized: original.is_maximized(),
        ..WindowEntry::default()
    })
}

/// Marks the entry hidden from `before`, the placement read just now.
pub fn plan_hide(entry: &mut WindowEntry, before: Placement) {
    entry.hide_placement = Some(before);
    entry.hidden = Some(Hidden::Minimized);
    entry.hidden_by = Some(HiddenBy::Nook);
}

/// The minimized placement for a window hidden from `before`. A maximized window keeps its
/// restore-to-maximized flag, so even a restore that has lost the journal brings it back
/// maximized.
pub fn hidden_from(before: Placement) -> Placement {
    let keep = if before.is_maximized() {
        WPF_RESTORETOMAXIMIZED
    } else {
        0
    };
    Placement {
        show_cmd: SW_SHOWMINNOACTIVE,
        flags: before.flags | keep,
        ..before
    }
    .quiet()
}
