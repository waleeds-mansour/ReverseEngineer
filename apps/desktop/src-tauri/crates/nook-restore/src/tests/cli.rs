use crate::cli::{exit_code, maybe_run, parse, summary, DEFAULT_WAIT_MS, FLAG};
use crate::recover::Reason;
use std::path::PathBuf;

#[test]
fn without_the_flag_hearth_starts_as_usual() {
    assert_eq!(parse(["hearth.exe", "--start-hidden"]), None);
    assert_eq!(parse(["hearth.exe", "hearth://open/inbox"]), None);
    assert_eq!(maybe_run(["hearth.exe"]), None);
    // The flag must be the exact word, never part of a deep link.
    assert_eq!(
        parse(["hearth.exe", "hearth://x?--nook-restore-windows"]),
        None
    );
}

#[test]
fn the_installer_flags_parse() {
    let options = parse([
        "hearth.exe",
        FLAG,
        "--reason=update",
        "--wait-ms=5000",
        "--quiet",
    ])
    .unwrap();
    assert_eq!(options.reason, Reason::Update);
    assert_eq!(options.wait_ms, 5000);
    assert!(options.quiet && options.ignored.is_empty());

    let options = parse(["hearth.exe", FLAG, "--reason=uninstall"]).unwrap();
    assert_eq!(
        (options.reason, options.wait_ms),
        (Reason::Uninstall, DEFAULT_WAIT_MS)
    );
    assert!(!options.quiet);
}

#[test]
fn the_guard_can_say_where_the_journal_is() {
    let options = parse([
        "nook-guard.exe",
        FLAG,
        "--nook-dir=C:\\Users\\x\\AppData\\Local\\app.hearth.desktop\\nook",
        "--hearth-version=1.2.3",
        "--nook-tag=kill-7",
    ])
    .unwrap();
    let dir = PathBuf::from("C:\\Users\\x\\AppData\\Local\\app.hearth.desktop\\nook");
    assert_eq!(options.nook_dir, Some(dir));
    assert_eq!(options.hearth_version.as_deref(), Some("1.2.3"));
    assert_eq!(options.nook_tag.as_deref(), Some("kill-7"));
    let plain = parse(["hearth.exe", FLAG]).unwrap();
    assert_eq!(plain.nook_tag, None, "the session's own objects by default");
}

#[test]
fn the_log_names_who_ran_the_restore() {
    assert_eq!(parse(["hearth.exe", FLAG]).unwrap().by, "cli");
    let hooks = parse(["hearth.exe", FLAG, "--reason=update", "--by=installer"]).unwrap();
    assert_eq!(hooks.by, "installer");
    // Anything that could break a log line is ignored, and the restore still runs.
    let odd = parse(["hearth.exe", FLAG, "--by=a b\nrestored"]).unwrap();
    assert_eq!((odd.by.as_str(), odd.ignored.len()), ("cli", 1));
}

#[test]
fn a_bad_value_still_restores_with_the_default() {
    let options = parse(["hearth.exe", FLAG, "--reason=everything", "--wait-ms=soon"]).unwrap();
    assert_eq!(
        (options.reason, options.wait_ms),
        (Reason::User, DEFAULT_WAIT_MS)
    );
    assert_eq!(options.ignored.len(), 2);
}

#[test]
fn the_summary_reads_plainly() {
    assert_eq!(summary(0, 0), "Nook had no windows to put back.");
    assert_eq!(summary(1, 0), "Nook put 1 window back.");
    assert_eq!(summary(7, 0), "Nook put 7 windows back.");
    assert_eq!(
        summary(3, 1),
        "Nook put 3 windows back and couldn't put 1 window back."
    );
    assert_eq!((exit_code(0), exit_code(2)), (0, 1));
}
