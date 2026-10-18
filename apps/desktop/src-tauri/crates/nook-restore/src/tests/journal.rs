use super::support::*;
use crate::desktop::fake::FakeDesktop;
use crate::journal::{
    next_epoch, Hidden, HiddenBy, Journal, Loaded, State, WindowEntry, WriteError, Writer,
};
use crate::objects::Signals;
use crate::placement::{Hwnd, Placement, SW_SHOWMAXIMIZED};
use crate::recover::{origin, restore_all, Origin, Reason};

fn sample() -> Journal {
    let mut journal = Journal::new(VERSION, "s".into(), WM_PID, WM_START, BOOT);
    journal.ticks = TICKS - 1_000;
    journal.windows.push(WindowEntry {
        hwnd: Hwnd(0x1a2b),
        pid: 200,
        proc_start: 2_000,
        exe: "chrome.exe".into(),
        class: "Chrome_WidgetWin_1".into(),
        original: Placement::normal(R_CHROME),
        hide_placement: Some(Placement {
            show_cmd: SW_SHOWMAXIMIZED,
            ..Placement::normal(R_CHROME)
        }),
        hidden: Some(Hidden::Minimized),
        hidden_by: Some(HiddenBy::Nook),
        ..WindowEntry::default()
    });
    journal
}

fn found(loaded: Loaded) -> Journal {
    match loaded {
        Loaded::Found(journal) => journal,
        other => panic!("expected a journal, got {other:?}"),
    }
}

#[test]
fn round_trips_with_hex_handles() {
    let dir = TempDir::new("round");
    let store = dir.store();
    store.save(&sample()).unwrap();
    let text = std::fs::read_to_string(store.path()).unwrap();
    assert!(text.contains("\"hwnd\":\"0x1a2b\""), "{text}");
    assert!(text.contains("\"state\":\"active\""), "{text}");
    assert_eq!(found(store.load()), sample());
}

/// The journal's folder, without the journal itself.
fn others(store: &crate::journal::Store) -> Vec<String> {
    let dir = store.path().parent().unwrap();
    let names = std::fs::read_dir(dir).unwrap().flatten();
    let names = names.map(|e| e.file_name().to_string_lossy().into_owned());
    names.filter(|n| n != "journal.json").collect()
}

#[test]
fn atomic_write_survives_a_torn_temp_file() {
    let dir = TempDir::new("torn");
    let store = dir.store();
    let mut first = sample();
    first.seq = 1;
    store.save(&first).unwrap();

    // A writer that crashed halfway through the next journal left half of it in its temp file.
    let mut next = sample();
    next.seq = 2;
    let bytes = serde_json::to_vec(&next).unwrap();
    let stray = store.path().with_file_name("journal.json.4242-0.tmp");
    std::fs::write(&stray, &bytes[..bytes.len() / 2]).unwrap();
    assert_eq!(found(store.load()).seq, 1);

    // One that crashed after its temp file was complete but before the rename: still the old one.
    std::fs::write(&stray, &bytes).unwrap();
    assert_eq!(found(store.load()).seq, 1);

    // The next write uses a temp file of its own, lands whole and leaves nothing of its own.
    let mut third = sample();
    third.seq = 3;
    store.save(&third).unwrap();
    assert_eq!(found(store.load()).seq, 3);
    assert_eq!(others(&store), vec!["journal.json.4242-0.tmp".to_string()]);

    // A fresh temp file may be a live writer's, so tidying leaves it; a stale one goes.
    store.tidy();
    assert!(stray.exists());
    let old = std::time::SystemTime::now() - std::time::Duration::from_secs(120);
    let file = std::fs::File::options().write(true).open(&stray).unwrap();
    file.set_modified(old).unwrap();
    drop(file);
    store.tidy();
    assert!(others(&store).is_empty());
}

#[test]
fn two_writers_never_share_a_temp_file() {
    let dir = TempDir::new("temps");
    let store = dir.store();
    assert_ne!(store.temp_path(), store.temp_path());
    let threads: Vec<_> = (0..4u64)
        .map(|n| {
            let store = dir.store();
            std::thread::spawn(move || {
                let mut journal = sample();
                for seq in 0..25 {
                    journal.seq = n * 100 + seq;
                    store.save(&journal).unwrap();
                }
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    // Every rename moved one whole journal, so the last one standing reads.
    assert_eq!(found(store.load()).seq % 100, 24);
    assert!(others(&store).is_empty());
}

#[test]
fn unreadable_files_are_corrupt_and_missing_is_missing() {
    let dir = TempDir::new("corrupt");
    let store = dir.store();
    assert!(matches!(store.load(), Loaded::Missing));
    for bad in [
        &b"{\"v\":2,\"windows\":[{\"hwnd\":"[..],
        b"\xff\xfe",
        b"[1,2,3]",
        b"",
    ] {
        std::fs::write(store.path(), bad).unwrap();
        assert!(matches!(store.load(), Loaded::Corrupt(_)), "{bad:?}");
    }
}

#[test]
fn another_schema_still_reads_and_is_restored_conservatively() {
    let dir = TempDir::new("schema");
    let store = dir.store();
    let text = format!(
        r#"{{"v":3,"boot_time":{BOOT},"state":"active","future":true,
            "windows":[{{"hwnd":"0x10","pid":200,"new_field":[1]}}]}}"#
    );
    std::fs::write(store.path(), text).unwrap();
    let journal = found(store.load());
    assert_eq!(journal.v, 3);
    assert_eq!(journal.windows[0].hwnd, Hwnd(0x10));
    assert_eq!(origin(&journal, &ctx()), Origin::OtherVersion);

    let mut other = ctx();
    other.hearth_version = Some("2.0.0".into());
    assert_eq!(origin(&sample(), &other), Origin::OtherVersion);
    other.hearth_version = None;
    assert_eq!(origin(&sample(), &other), Origin::Current);
}

#[test]
fn only_the_tick_count_tells_another_boot() {
    let mut other = ctx();
    assert_eq!(origin(&sample(), &other), Origin::Current);
    // The clock was corrected by 12 seconds either way: "now minus uptime" moves with it, and
    // it is still the same boot.
    for shift in [12_000, 0u64.wrapping_sub(12_000)] {
        other.now_ms = NOW.wrapping_add(shift);
        other.boot_time_ms = BOOT.wrapping_add(shift);
        assert_eq!(origin(&sample(), &other), Origin::Current, "{shift}");
    }
    // A writer landed its journal a moment after this restorer read the clock.
    let mut ahead = sample();
    ahead.ticks = TICKS + 2_000;
    assert_eq!(origin(&ahead, &ctx()), Origin::Current);
    // Windows restarted: its tick count began again below the one the journal recorded.
    other.ticks_ms = 90_000;
    assert_eq!(origin(&sample(), &other), Origin::OtherBoot);
    // A journal from before the tick count was recorded reads as this boot's.
    let mut old = sample();
    old.ticks = 0;
    assert_eq!(origin(&old, &other), Origin::Current);
}

#[test]
fn every_write_records_the_tick_count() {
    let dir = TempDir::new("ticks");
    let world = FakeDesktop::new();
    let mut wm = Wm::start(&world, dir.store());
    let later = crate::clock::Clock {
        now_ms: NOW + 5,
        ticks_ms: TICKS + 5,
    };
    let mut journal = wm.journal.clone();
    wm.writer.write(&wm.signals, &mut journal, later).unwrap();
    let on_disk = found(dir.store().load());
    assert_eq!((on_disk.written_at, on_disk.ticks), (NOW + 5, TICKS + 5));
}

#[test]
fn epochs_only_go_up() {
    assert_eq!(next_epoch(None, 5), 5);
    assert_eq!(next_epoch(Some(9), 5), 10);
    assert_eq!(next_epoch(Some(3), 50), 50);
    assert_eq!(next_epoch(Some(u64::MAX), 0), u64::MAX);
}

#[test]
fn a_writer_with_an_older_epoch_cannot_write() {
    let dir = TempDir::new("epoch");
    let world = FakeDesktop::new();
    let mut wm = Wm::start(&world, dir.store());
    let mut journal = wm.journal.clone();
    wm.writer.write(&wm.signals, &mut journal, CLOCK).unwrap();

    // A restorer in another process, which never saw this writer's shared objects, takes the
    // journal over with a later epoch. Only the file tells this writer it lost.
    let elsewhere = FakeDesktop::new();
    let report = restore_all(
        &restorer(&elsewhere),
        &dir.store(),
        &elsewhere.signals(),
        &ctx(),
        Reason::User,
    );
    assert!(report.journal_error.is_none());
    let after_restore = found(dir.store().load());
    assert!(after_restore.epoch > wm.writer.epoch());

    let err = wm
        .writer
        .write(&wm.signals, &mut journal, CLOCK)
        .unwrap_err();
    assert!(matches!(err, WriteError::Stale { .. }), "{err}");
    assert_eq!(found(dir.store().load()), after_restore);
}

#[test]
fn a_revoked_writer_cannot_write_and_nobody_claims_a_dirty_journal() {
    let dir = TempDir::new("claim");
    let world = FakeDesktop::new();
    let mut wm = Wm::start(&world, dir.store());
    let mut journal = wm.journal.clone();

    // The journal reads 'active': a second run may not take it over before a restore.
    let mut second = Journal::new(VERSION, "two".into(), 101, 1_001, BOOT);
    let err = Writer::claim(dir.store(), &world.signals(), &mut second, CLOCK).err();
    assert!(matches!(err, Some(WriteError::Dirty(_))));

    world.signals().revoke(wm.writer.epoch() + 1);
    let err = wm
        .writer
        .write(&wm.signals, &mut journal, CLOCK)
        .unwrap_err();
    assert!(matches!(err, WriteError::Revoked));

    // After the restore the journal is clean, and a new run outranks the old one.
    restore_all(
        &restorer(&world),
        &dir.store(),
        &world.signals(),
        &ctx(),
        Reason::User,
    );
    let next = Writer::claim(dir.store(), &world.signals(), &mut second, CLOCK).unwrap();
    assert!(next.epoch() > wm.writer.epoch());
    assert!(!world.signals().is_revoked(next.epoch()));
    assert!(wm.writer.write(&wm.signals, &mut journal, CLOCK).is_err());
    assert_eq!(found(dir.store().load()).state, State::Active);
}

#[test]
fn the_journal_mutex_held_elsewhere_times_out_the_writer() {
    let dir = TempDir::new("mutex");
    let world = FakeDesktop::new();
    let mut wm = Wm::start(&world, dir.store());
    let mut journal = wm.journal.clone();
    let other = world.signals();
    assert!(other.lock_journal(std::time::Duration::ZERO));
    let err = wm
        .writer
        .write(&wm.signals, &mut journal, CLOCK)
        .unwrap_err();
    assert!(matches!(err, WriteError::LockTimeout));
    other.unlock_journal();
    wm.writer.write(&wm.signals, &mut journal, CLOCK).unwrap();
}
