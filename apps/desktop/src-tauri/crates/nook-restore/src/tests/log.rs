use super::support::*;
use crate::desktop::DesktopError;
use crate::log::{file, restored, stamp, Restored, KEEP, MAX_BYTES};
use crate::placement::Hwnd;
use crate::recover::Report;

#[test]
fn stamps_read_as_utc_with_milliseconds() {
    for (ms, text) in [
        (0, "1970-01-01T00:00:00.000Z"),
        (1_760_000_000_000, "2025-10-09T08:53:20.000Z"),
        (951_782_400_000, "2000-02-29T00:00:00.000Z"),
        (1_709_164_800_123, "2024-02-29T00:00:00.123Z"),
        (1_767_225_599_999, "2025-12-31T23:59:59.999Z"),
        (4_102_444_799_999, "2099-12-31T23:59:59.999Z"),
    ] {
        assert_eq!(stamp(ms), text, "{ms}");
    }
}

#[test]
fn a_restore_line_is_numbers_on_one_line() {
    let report = Report {
        restored: 3,
        skipped: 1,
        failed: vec![(Hwnd(0x10), DesktopError::Denied)],
        swept: Some(2),
        dropped: true,
        late_pass_fixes: Some(1),
        locked: true,
        journal_error: Some("not a journal:\nline 1".into()),
        ..Report::default()
    };
    let text = Restored {
        by: "guard",
        report: &report,
    }
    .to_string();
    assert_eq!(
        text,
        "restored by=guard windows=3 skipped=1 failed=1 second_pass=0 locked=true late_pass=1 \
         swept=2 dropped=other-boot journal_error=not a journal: line 1"
    );
}

#[test]
fn the_cli_and_the_guard_log_only_where_nook_already_has_a_folder() {
    let dir = TempDir::new("log");
    let nook = dir.store().path().parent().unwrap().join("nook");
    restored(&nook, "cli", &Report::default());
    assert!(
        !nook.exists(),
        "no folder made just to say nothing happened"
    );

    std::fs::create_dir_all(&nook).unwrap();
    restored(&nook, "installer", &Report::default());
    let text = std::fs::read_to_string(file(&nook, 0)).unwrap();
    assert!(text.ends_with(
        " restored by=installer windows=0 skipped=0 failed=0 second_pass=0 locked=false\n"
    ));
}

#[test]
fn the_log_keeps_at_most_three_full_files() {
    let dir = TempDir::new("log-rotate");
    let nook = dir.store().path().parent().unwrap().to_path_buf();
    let line = format!("{}\n", "y".repeat(400 * 1024));
    for _ in 0..10 {
        crate::log::append(&nook, &line).unwrap();
    }
    for n in 0..KEEP {
        let len = std::fs::metadata(file(&nook, n)).unwrap().len();
        assert!(len <= MAX_BYTES, "nook.{n}.log is {len} bytes");
    }
    assert!(!file(&nook, KEEP).exists());
}
