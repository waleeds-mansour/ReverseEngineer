// Kill tests for nook-guard and the restore (docs/nook-wm.md, "Testing", and P0's exit
// criteria). Every window here belongs to nook-testwin, started on a private desktop that is
// never switched to; the host, its guard and every restorer run on that desktop too, with a
// journal folder and object tag of the run's own. They are ignored by default because they start
// real processes and take minutes:
//
//   cargo build --examples
//   cargo test --test kill -- --ignored --test-threads=1 --nocapture
//
// NOOK_KILL_RUNS sets the number of runs (20 randomized, 10 first-pass by default),
// NOOK_KILL_SEED replays a seed, and NOOK_GUARD_EXE measures another guard build (the release
// one, for its memory).

#![cfg(windows)]

mod desk;
mod jobs;
mod probe;
mod procs;
mod runs;
mod scenarios;
mod setup;

use procs::{context_switches, parent_pid, taskkill_tree};
use runs::{Outcome, Run};
use setup::{exes, Rng};
use std::collections::BTreeMap;
use std::time::Duration;

fn env_u64(name: &str) -> Option<u64> {
    let text = std::env::var(name).ok()?;
    let text = text.trim();
    match text.strip_prefix("0x") {
        Some(hex) => u64::from_str_radix(hex, 16).ok(),
        None => text.parse().ok(),
    }
}

fn report(n: usize, outcome: &Outcome) {
    let verdict = if outcome.problems.is_empty() {
        "clean"
    } else {
        "FAILED"
    };
    println!(
        "run {n:>3}: {:<26} {:<36} at {:<16} guards {:?} -> {verdict}",
        outcome.scenario,
        outcome.detail,
        outcome.kill_label.as_deref().unwrap_or("-"),
        outcome.guard_codes,
    );
    for note in &outcome.notes {
        println!("          {note}");
    }
    for problem in &outcome.problems {
        println!("          PROBLEM: {problem}");
    }
    if !outcome.problems.is_empty() {
        for line in &outcome.log {
            println!("          | {line}");
        }
    }
}

#[test]
#[ignore = "starts real processes and windows on a private desktop; see the file"]
fn randomized_kill_runs_leave_no_window_changed() {
    let runs = env_u64("NOOK_KILL_RUNS").unwrap_or(20) as usize;
    let seed = env_u64("NOOK_KILL_SEED").unwrap_or_else(|| {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
        now.map(|d| d.as_nanos() as u64).unwrap_or(1)
    });
    println!("{runs} kill runs, seed {seed:#x}");
    let exes = exes();
    let mut by_scenario: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut points: BTreeMap<String, usize> = BTreeMap::new();
    let mut codes: BTreeMap<String, usize> = BTreeMap::new();
    let mut failed = Vec::new();
    let (mut border_checked, mut cloak_checked) = (0, 0);
    for n in 0..runs {
        let mut rng = Rng::new(seed ^ (n as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let outcome = scenarios::one(&exes, &format!("r{n}"), &mut rng);
        report(n, &outcome);
        border_checked += usize::from(outcome.border_checked);
        cloak_checked += usize::from(outcome.cloak_checked);
        let entry = by_scenario.entry(outcome.scenario).or_default();
        entry.0 += 1;
        if !outcome.problems.is_empty() {
            entry.1 += 1;
            failed.push(n);
        }
        let point = outcome.kill_label.clone().unwrap_or_else(|| "-".into());
        *points.entry(point).or_default() += 1;
        for code in &outcome.guard_codes {
            let name = match code {
                Some(procs::KILLED) => "killed by the test".to_string(),
                Some(c) => format!("exit {c}"),
                None => "still running".to_string(),
            };
            *codes.entry(name).or_default() += 1;
        }
    }
    println!(
        "\nseed {seed:#x}: {} of {runs} runs clean",
        runs - failed.len()
    );
    for (scenario, (count, bad)) in &by_scenario {
        println!("  {scenario:<26} {count:>4} runs, {bad} failed");
    }
    println!("  where the kill or stall landed: {points:?}");
    println!("  guards: {codes:?}");
    println!("  cloaked state read back in {cloak_checked} of {runs} runs");
    println!("  border colour read back in {border_checked} of {runs} runs");
    assert!(failed.is_empty(), "runs {failed:?} left windows changed");
}

#[test]
#[ignore = "starts real processes and windows on a private desktop; see the file"]
fn the_first_pass_alone_puts_every_window_back() {
    // Every window moved, bordered and hidden, then nothing after the guard's first pass: a
    // placement Windows drops there would stay dropped, because the journal already reads clean.
    let exes = exes();
    let mut rng = Rng::new(0x0F1A_57A5);
    let mut failed = Vec::new();
    for n in 0..env_u64("NOOK_KILL_RUNS").unwrap_or(10) as usize {
        let outcome = scenarios::guard_after_first_pass(&exes, &format!("p{n}"), &mut rng, None);
        report(n, &outcome);
        if !outcome.problems.is_empty() {
            failed.push(n);
        }
    }
    assert!(failed.is_empty(), "runs {failed:?} left windows changed");
}

#[test]
#[ignore = "starts real processes and windows on a private desktop; see the file"]
fn a_stalled_writer_makes_no_writes_once_a_restore_starts() {
    let exes = exes();
    let mut rng = Rng::new(0x057A_11ED);
    let cases = [
        ("stall-guard-5s", false, 5_000),
        ("stall-guard-300ms", false, 300),
        ("stall-cli", true, 5_000),
    ];
    let mut failed = Vec::new();
    for (n, (label, by_cli, beat)) in cases.into_iter().enumerate() {
        let outcome = scenarios::stalled(&exes, label, &mut rng, Some(by_cli), beat);
        report(n, &outcome);
        if !outcome.problems.is_empty() {
            failed.push(label);
        }
    }
    assert!(failed.is_empty(), "{failed:?}");
}

#[test]
#[ignore = "starts real processes and windows on a private desktop; see the file"]
fn the_guard_is_outside_its_starters_tree_and_survives_taskkill() {
    let exes = exes();
    // The lenient job lets the guard leave it, the way it leaves a job Hearth runs in.
    let mut run = Run::start_in(&exes, "taskkill", &[], jobs::Job::Lenient);
    assert!(run.reach(run.plan), "the host finished its steps");
    std::thread::sleep(Duration::from_millis(200));
    let host_pid = run.host.process.pid;
    let guard = &run.guards[0];
    let launcher = parent_pid(guard.pid);
    println!(
        "host {host_pid}, guard {} started by {launcher:?}",
        guard.pid
    );
    println!(
        "in a job: host {:?}, guard {:?}",
        run.host.process.in_job(),
        guard.in_job()
    );
    assert_ne!(
        launcher,
        Some(host_pid),
        "the guard's parent is not the host"
    );
    // taskkill /T follows recorded parent pids, and one of the owner's programs could name a
    // long-dead parent whose pid the host now has. So it runs only if everything in the host's
    // tree started after the host did, which makes it the host's own (its console host).
    let reach = procs::tree(host_pid);
    let host_start = procs::created(host_pid).expect("the host's start time");
    let foreign: Vec<_> = reach
        .iter()
        .filter(|p| p.0 != host_pid && procs::created(p.0).is_none_or(|t| t <= host_start))
        .collect();
    println!("taskkill /T can reach: {reach:?}");
    assert!(
        foreign.is_empty(),
        "taskkill /T could reach programs that aren't the host's, so it was not run: {foreign:?}"
    );
    assert!(
        !reach.iter().any(|p| p.0 == guard.pid),
        "the guard is not in the host's tree"
    );
    println!(
        "the harness is in a job: {:?}; the guard is in the test's job: {:?}",
        procs::harness_in_job(),
        guard.in_job_of(jobs::handle(jobs::Job::Lenient))
    );
    // taskkill /F ends every process it reaches with exit code 1.
    run.host_kill_code = 1;
    let said = taskkill_tree(host_pid);
    println!("taskkill /T /F /PID {host_pid}: {said}");
    assert!(
        run.host.process.wait(Duration::from_secs(10)),
        "the host died"
    );
    // The guard noticed and is restoring (its second pass waits a second), so it is still alive
    // right after the tree kill: taskkill did not reach it.
    assert!(
        guard.alive(),
        "the guard survived taskkill /T of its starter"
    );
    assert!(
        guard.wait(Duration::from_secs(25)),
        "the guard ended after restoring"
    );
    let code = guard.exit_code();
    let outcome = run.finish("taskkill /T", format!("guard exit {code:?}"));
    report(0, &outcome);
    assert_eq!(
        code,
        Some(0),
        "the guard ended by itself with every window back"
    );
    assert!(outcome.problems.is_empty());
}

/// Waits for the loader's worker threads to leave, so only the guard's own thread is counted.
fn settle_threads(pid: u32) -> u32 {
    let mut threads = 0;
    for _ in 0..40 {
        threads = context_switches(pid).map_or(0, |(_, t)| t);
        if threads <= 1 {
            break;
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    threads
}

/// Wakeups (context switches), CPU cycles and private bytes over `window`.
fn measure(guard: &procs::Proc, window: Duration) -> (u64, u64, usize, u32) {
    let (before, _) = context_switches(guard.pid).expect("the guard's threads");
    let cycles = guard.cycles().unwrap_or(0);
    std::thread::sleep(window);
    let (after, threads) = context_switches(guard.pid).expect("the guard's threads");
    let used = guard.cycles().unwrap_or(0).saturating_sub(cycles);
    let private = guard.private_bytes().unwrap_or(usize::MAX);
    (after - before, used, private, threads)
}

#[test]
#[ignore = "starts real processes and windows on a private desktop; see the file"]
fn the_guard_sleeps_while_disarmed_and_stays_small() {
    let exes = exes();
    println!("guard: {}", exes.guard.display());
    let mut run = Run::start(&exes, "idle-disarmed", &["--until=0".into()]);
    assert!(run.reach(run.plan));
    let threads = settle_threads(run.guards[0].pid);
    let (wakeups, cycles, private, now) = measure(&run.guards[0], Duration::from_secs(30));
    println!(
        "disarmed, 30 s: {wakeups} wakeups, {cycles} cycles, {} KB private, threads {threads} then {now}",
        private / 1024
    );
    run.kill_host();
    let outcome = run.finish("disarmed", String::new());
    report(0, &outcome);
    assert!(outcome.problems.is_empty());
    assert_eq!(wakeups, 0, "the disarmed guard never wakes");
    assert!(private <= 8 << 20, "8 MB private or less");

    // Armed at the default 5 s beat: about one wakeup per beat. A thread that does nothing but
    // wait 5 s at a time shows about 0.22 context switches a second on the owner's PC, a little
    // over one per timeout, so that is the floor here.
    let mut run = Run::start(&exes, "idle-armed", &["--until=2".into()]);
    assert!(run.reach(run.plan));
    settle_threads(run.guards[0].pid);
    let (wakeups, cycles, private, threads) = measure(&run.guards[0], Duration::from_secs(60));
    println!(
        "armed, 60 s: {wakeups} wakeups ({:.2}/s), {cycles} cycles, {} KB private, {threads} threads",
        wakeups as f64 / 60.0,
        private / 1024
    );
    run.kill_host();
    let outcome = run.finish("armed", String::new());
    report(1, &outcome);
    assert!(outcome.problems.is_empty());
    assert!(wakeups <= 24, "about 0.2 wakeups a second while armed");
    assert!(private <= 8 << 20, "8 MB private or less");
}
