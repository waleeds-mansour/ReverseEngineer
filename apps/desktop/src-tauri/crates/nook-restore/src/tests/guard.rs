// The guard's arguments: what Hearth writes is what the guard reads, and a command line built
// for CreateProcessW splits back into the same arguments.

use crate::guard::{parse, reported_pid, Options, Parent, Role, BEAT, LAUNCH, WATCH};
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

fn with_role(role: &str, options: &Options) -> Vec<OsString> {
    let mut args = vec![OsString::from("nook-guard.exe"), OsString::from(role)];
    args.extend(options.to_args());
    args
}

#[test]
fn the_arguments_hearth_writes_read_back_the_same() {
    let mut options = Options::new(Parent {
        pid: 4_812,
        start: 133_700_000_000_000_000,
    });
    options.nook_dir = Some(PathBuf::from("C:\\Users\\a b\\AppData\\Local\\nook"));
    options.tag = Some("kill-1-r3".into());
    options.hearth_version = Some("1.2.3".into());
    options.beat = Duration::from_millis(250);
    let launch = parse(with_role(LAUNCH, &options));
    assert_eq!(launch, Some(Role::Launch(options.clone())));
    assert_eq!(
        parse(with_role(WATCH, &options)),
        Some(Role::Watch(options))
    );
}

#[test]
fn the_defaults_stay_off_the_command_line() {
    let options = Options::new(Parent { pid: 8, start: 9 });
    assert_eq!(options.to_args(), vec![OsString::from("--parent=8:9")]);
    let Some(Role::Watch(read)) = parse(with_role(WATCH, &options)) else {
        panic!("a watch");
    };
    assert_eq!((read.beat, read.nook_dir, read.tag), (BEAT, None, None));
}

#[test]
fn without_a_parent_or_a_role_there_is_nothing_to_watch() {
    assert_eq!(parse(["nook-guard.exe", WATCH]), None);
    assert_eq!(parse(["nook-guard.exe", "--parent=8:9"]), None);
    assert_eq!(parse(["nook-guard.exe", WATCH, "--parent=eight"]), None);
    assert_eq!(parse(["nook-guard.exe"]), None);
}

#[test]
fn a_beat_out_of_range_keeps_the_default() {
    for bad in ["--beat-ms=0", "--beat-ms=soon", "--beat-ms=99999999"] {
        let Some(Role::Watch(read)) = parse(["nook-guard.exe", WATCH, "--parent=8:9", bad]) else {
            panic!("a watch");
        };
        assert_eq!(read.beat, BEAT, "{bad}");
    }
}

#[test]
fn only_a_process_id_reads_as_a_guard() {
    // Process ids are multiples of four above the system's own.
    assert_eq!(reported_pid(9_316), Some(9_316));
    for failure in [0, 1, 2, 4, 101, 259, 0xC000_0005] {
        assert_eq!(reported_pid(failure), None, "{failure:#x}");
    }
}

#[cfg(windows)]
#[test]
fn a_command_line_splits_back_into_the_same_arguments() {
    use crate::guard::spawn::command_line;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::UI::Shell::CommandLineToArgvW;

    let exe = PathBuf::from("C:\\Program Files\\Hearth\\nook-guard.exe");
    let args: Vec<OsString> = [
        "--watch",
        "--nook-dir=C:\\Users\\a b\\nook\\",
        "plain",
        "",
        "say \"hi\"",
        "trailing\\\\",
    ]
    .iter()
    .map(OsString::from)
    .collect();
    let line = command_line(&exe, &args);
    let mut count = 0;
    let argv = unsafe { CommandLineToArgvW(PCWSTR(line.as_ptr()), &mut count) };
    assert!(!argv.is_null());
    let read: Vec<OsString> = (0..count as usize)
        .map(|i| {
            let arg = unsafe { *argv.add(i) };
            OsString::from(String::from_utf16_lossy(unsafe { arg.as_wide() }))
        })
        .collect();
    unsafe {
        let _ = LocalFree(Some(HLOCAL(argv.cast())));
    }
    let mut expected = vec![exe.into_os_string()];
    expected.extend(args);
    assert_eq!(read, expected);
}
