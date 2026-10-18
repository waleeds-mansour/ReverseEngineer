// What Nook decides when Hearth starts (docs/nook-wm.md, "KILL SWITCH" and "AFTER AN UNCLEAN
// END"): whether it is held off, and whether the last run left windows to put back. Two of the
// kill switch's layers live here: the `disabled` file, which forces the window manager off however
// the settings read, and safe start, which keeps it off after two unclean ends within 10 minutes
// until the owner clears it.

use super::settings::NookSettings;
use std::path::Path;

/// %LOCALAPPDATA%\app.hearth.desktop\nook\disabled, or the portable Data\nook\disabled.
pub const DISABLED_FILE: &str = "disabled";
/// Two unclean ends this close together mean safe start.
pub const SAFE_START_WITHIN_MS: u64 = 10 * 60 * 1000;

/// Why Nook isn't arranging windows. Every state is off in this version; they differ in what the
/// owner has to do about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// Every capability is off, as it is by default.
    Off,
    /// The disabled file forces the window manager off.
    Disabled,
    /// Nook ended uncleanly twice within 10 minutes, and stays off until the owner clears it.
    SafeStart,
    /// The settings ask for a capability this version doesn't have yet.
    NotInThisVersion,
}

impl Status {
    /// Whether Nook arranges windows in this state, which is when the tray offers Pause and Put
    /// back. None of this version's states does.
    pub fn arranges(self) -> bool {
        match self {
            Status::Off | Status::Disabled | Status::SafeStart | Status::NotInThisVersion => false,
        }
    }

    /// For nook.log, when the settings asked for something and Nook held off.
    pub fn why(self) -> &'static str {
        match self {
            Status::Off => "every capability is off",
            Status::Disabled => "the disabled file is there",
            Status::SafeStart => "safe start, after two unclean ends within 10 minutes",
            Status::NotInThisVersion => "this version has no window manager yet",
        }
    }
}

/// Whether the disabled file is there. Anything at that path counts, even a folder: the file is
/// there to be made by hand, and a mistake in making it must still turn Nook off.
pub fn disabled(dir: &Path) -> bool {
    dir.join(DISABLED_FILE).exists()
}

/// Two unclean ends within 10 minutes of each other, both after the owner last cleared safe start.
pub fn safe_start(unclean: &[u64], cleared_at: u64) -> bool {
    let mut ends: Vec<u64> = unclean
        .iter()
        .copied()
        .filter(|&t| t > cleared_at)
        .collect();
    ends.sort_unstable();
    ends.windows(2)
        .any(|pair| pair[1] - pair[0] <= SAFE_START_WITHIN_MS)
}

/// Nook's status at start. The file flag comes first, since it is the kill switch the owner can
/// reach without Hearth, then safe start, then the settings.
pub fn status(settings: &NookSettings, disabled: bool, unclean: &[u64]) -> Status {
    if disabled {
        Status::Disabled
    } else if safe_start(unclean, settings.safe_start_cleared_at) {
        Status::SafeStart
    } else if settings.any_on() {
        Status::NotInThisVersion
    } else {
        Status::Off
    }
}

/// How the last run's journal reads, as far as the start check cares.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Journal {
    /// No journal: Nook never touched a window here, or its last restore left nothing behind.
    Missing,
    /// A journal that reads clean, or clean for an update: nothing is owed.
    Clean,
    /// A journal that may still owe a restore.
    Dirty,
    /// A journal that doesn't read; the restore falls back to Nook's window markers.
    Corrupt,
}

/// Whether the start check has work to do. It may put windows back, so it runs on a thread of its
/// own; with a missing or clean journal no thread is started at all.
pub fn needs_check(journal: Journal) -> bool {
    matches!(journal, Journal::Dirty | Journal::Corrupt)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = 60 * 1000;

    #[test]
    fn nothing_on_and_nothing_wrong_reads_off() {
        assert_eq!(status(&NookSettings::default(), false, &[]), Status::Off);
    }

    #[test]
    fn the_disabled_file_wins_over_everything() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(!disabled(tmp.path()));
        std::fs::write(tmp.path().join(DISABLED_FILE), "").unwrap();
        assert!(disabled(tmp.path()));
        let on = NookSettings {
            enabled: true,
            ..NookSettings::default()
        };
        assert_eq!(status(&on, true, &[MIN, 2 * MIN]), Status::Disabled);
    }

    #[test]
    fn a_folder_named_disabled_counts_too() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir(tmp.path().join(DISABLED_FILE)).unwrap();
        assert!(disabled(tmp.path()));
    }

    #[test]
    fn two_unclean_ends_within_ten_minutes_mean_safe_start() {
        assert!(safe_start(&[100 * MIN, 109 * MIN], 0));
        assert!(safe_start(&[100 * MIN, 110 * MIN], 0));
        assert!(!safe_start(&[100 * MIN, 111 * MIN], 0));
        assert!(!safe_start(&[100 * MIN], 0));
        assert!(!safe_start(&[], 0));
    }

    #[test]
    fn safe_start_looks_at_every_pair_in_any_order() {
        assert!(safe_start(&[300 * MIN, 10 * MIN, 305 * MIN, 100 * MIN], 0));
    }

    #[test]
    fn clearing_safe_start_forgets_the_ends_before_it() {
        let ends = [100 * MIN, 105 * MIN];
        assert!(!safe_start(&ends, 105 * MIN));
        assert!(!safe_start(&ends, 102 * MIN));
        assert!(safe_start(&[100 * MIN, 105 * MIN, 107 * MIN], 102 * MIN));
    }

    #[test]
    fn safe_start_comes_before_the_settings() {
        let on = NookSettings {
            ring: true,
            ..NookSettings::default()
        };
        assert_eq!(status(&on, false, &[MIN, 2 * MIN]), Status::SafeStart);
        assert_eq!(status(&on, false, &[]), Status::NotInThisVersion);
    }

    #[test]
    fn only_a_journal_that_may_owe_a_restore_starts_a_thread() {
        assert!(!needs_check(Journal::Missing));
        assert!(!needs_check(Journal::Clean));
        assert!(needs_check(Journal::Dirty));
        assert!(needs_check(Journal::Corrupt));
    }
}
