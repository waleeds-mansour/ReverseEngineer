// The randomized kill runs (docs/nook-wm.md, "Kill tests"): the host adopts, moves, borders and
// hides the test windows step by step, and each run kills the host, the guard or both at a random
// point, or wedges the host, then lets the restorers that would really run do their part.

use crate::probe;
use crate::procs::wait_clean_journal;
use crate::runs::{Outcome, Run};
use crate::setup::{Exes, Rng, WINDOWS};
use std::time::{Duration, Instant};

/// The heartbeat for most runs: a wedged host is caught after three of these.
const BEAT_MS: u64 = 300;

fn normal_args() -> Vec<String> {
    vec![format!("--beat-ms={BEAT_MS}"), "--step-ms=3".into()]
}

/// One randomized run, its scenario picked by `rng`.
pub fn one(exes: &Exes, label: &str, rng: &mut Rng) -> Outcome {
    match rng.below(100) {
        0..=24 => host_killed(exes, label, rng),
        25..=37 => guard_then_host(exes, label, rng),
        38..=50 => both_killed(exes, label, rng),
        51..=63 => guard_mid_restore(exes, label, rng),
        64..=75 => {
            let k = rng.below(36);
            guard_after_first_pass(exes, label, rng, Some(k as usize))
        }
        76..=89 => stalled(exes, label, rng, None, BEAT_MS),
        90..=94 => answered(exes, label, rng),
        _ => update_answered(exes, label, rng),
    }
}

/// The host dies; its guard restores.
fn host_killed(exes: &Exes, label: &str, rng: &mut Rng) -> Outcome {
    let mut run = Run::start(exes, label, &normal_args());
    let k = rng.below(run.plan as u64 + 1) as usize;
    run.reach(k);
    Run::jitter(rng);
    if k >= run.plan {
        witness(&mut run);
    }
    run.kill_host();
    run.finish("host killed", format!("k={k}"))
}

/// Checks, before a kill at the end of the plan, that the host's writes really landed, so a
/// clean result later means the restore cleaned them up.
fn witness(run: &mut Run) {
    std::thread::sleep(Duration::from_millis(150));
    let now = run.world.read();
    let dirt = probe::dirt(&run.world.baseline, &now);
    let hidden = WINDOWS - 1;
    if dirt.minimized != hidden || dirt.marked != WINDOWS || dirt.moved < 2 {
        run.problems
            .push(format!("witness: the host's writes didn't land: {dirt:?}"));
    }
    run.notes.push(format!("witness {dirt:?}"));
}

/// The guard dies; the host starts another; then the host dies and the new guard restores.
fn guard_then_host(exes: &Exes, label: &str, rng: &mut Rng) -> Outcome {
    let mut run = Run::start(exes, label, &normal_args());
    let k1 = rng.below(run.plan as u64) as usize;
    run.reach(k1);
    Run::jitter(rng);
    run.kill_guard();
    let k2 = k1 + 1 + rng.below((run.plan - k1) as u64) as usize;
    run.reach(k2);
    if !run.wait_guards(2) {
        run.problems.push("the host started no new guard".into());
    }
    Run::jitter(rng);
    run.kill_host();
    run.finish("guard killed, then host", format!("k1={k1} k2={k2}"))
}

/// Both die together; the next start or the CLI restores.
fn both_killed(exes: &Exes, label: &str, rng: &mut Rng) -> Outcome {
    let mut run = Run::start(exes, label, &normal_args());
    let k = rng.below(run.plan as u64 + 1) as usize;
    run.reach(k);
    Run::jitter(rng);
    let host_first = rng.coin();
    if host_first {
        run.kill_host();
        run.kill_guard();
    } else {
        run.kill_guard();
        run.kill_host();
    }
    run.after_both(rng);
    run.finish("both killed", format!("k={k} host_first={host_first}"))
}

/// The host dies, and its guard dies partway through the restore; the next start or the CLI
/// finishes it.
fn guard_mid_restore(exes: &Exes, label: &str, rng: &mut Rng) -> Outcome {
    let mut run = Run::start(exes, label, &normal_args());
    let k = rng.below(run.plan as u64 + 1) as usize;
    run.reach(k);
    Run::jitter(rng);
    run.kill_host();
    // Half the kills land in the first pass; the rest in the second's one-second wait or in the
    // second pass itself, which ends about a second after the host died.
    let delay = if rng.coin() {
        rng.below(30)
    } else {
        30 + rng.below(1050)
    };
    std::thread::sleep(Duration::from_millis(delay));
    let killed = run.kill_guard();
    run.after_both(rng);
    let detail = format!("k={k} guard_after_ms={delay} killed={killed}");
    run.finish("guard killed mid-restore", detail)
}

/// The host dies, and its guard dies just after its first pass marks the journal clean, before
/// the second pass. Nothing restores after it: the first pass alone must have put every window
/// back. `k` None kills the host once every step is done, with windows moved and hidden. The
/// journal reading clean is the sign, since the guard says Done only after its second pass.
pub fn guard_after_first_pass(
    exes: &Exes,
    label: &str,
    rng: &mut Rng,
    k: Option<usize>,
) -> Outcome {
    let mut run = Run::start(exes, label, &normal_args());
    let k = k.unwrap_or(run.plan).min(run.plan);
    run.reach(k);
    Run::jitter(rng);
    run.kill_host();
    let dir = run.world.dir.clone();
    let finished = match run.guards.last() {
        Some(guard) => wait_clean_journal(&dir, guard, Duration::from_secs(10)),
        None => false,
    };
    std::thread::sleep(Duration::from_millis(rng.below(40)));
    let killed = run.kill_guard();
    let detail = format!("k={k} clean={finished} killed={killed}");
    run.finish("guard killed after pass 1", detail)
}

/// The host wedges at a step; the guard (after missed beats of `beat_ms`) or the CLI restores;
/// the host then tries every write again and none may land. `by_cli` None picks at random.
pub fn stalled(
    exes: &Exes,
    label: &str,
    rng: &mut Rng,
    by_cli: Option<bool>,
    beat_ms: u64,
) -> Outcome {
    let by_cli = by_cli.unwrap_or_else(|| rng.coin());
    let delay = rng.below(800);
    // The stall point is chosen before the host starts, so the plan's length is fixed here: for
    // four test windows it is 2 + 8 + 4 + 12 + 9 steps. Claim and arm always come first.
    let plan = 35u64;
    let k = 2 + rng.below(plan - 2) as usize;
    // With the CLI restoring, the guard's beat is the default, so the CLI is first.
    let beat = if by_cli { 5_000 } else { beat_ms };
    let args = vec![
        format!("--beat-ms={beat}"),
        "--step-ms=3".into(),
        format!("--stall-at={k}"),
        format!("--stall-delay-ms={delay}"),
    ];
    let mut run = Run::start(exes, label, &args);
    assert_eq!(run.plan as u64, plan, "the plan for four windows");
    let stall = format!("stall {k}");
    let started = Instant::now();
    if run.next(|l| l == stall).is_none() {
        run.problems.push(format!("the host never stalled at {k}"));
    }
    run.set_label("stall");
    if by_cli {
        std::thread::sleep(Duration::from_millis(rng.below(300)));
        let wait = if rng.coin() { 0 } else { 300 };
        run.cli(wait);
    }
    // The guard notices after MISSED_BEATS beats, counted from the next beat, and the host
    // waits up to 800 ms more before it tries again; the rest is slack for a busy machine.
    let missed = u64::from(nook_restore::guard::MISSED_BEATS) + 2;
    let wait = Duration::from_millis(beat * missed + 800) + Duration::from_secs(5);
    let after = run.next_within(wait, |l| l.starts_with("after-stall "));
    let revoked_after = started.elapsed();
    match after.as_deref().map(parse_after) {
        Some(Some((ok, refused, other))) => {
            if ok > 0 {
                run.problems.push(format!(
                    "the stalled writer made {ok} writes after the restore began"
                ));
            }
            if refused == 0 {
                run.problems.push("the stalled writer tried nothing".into());
            }
            run.notes.push(format!(
                "after-stall ok={ok} refused={refused} other={other} in {} ms",
                revoked_after.as_millis()
            ));
        }
        _ => run
            .problems
            .push(format!("no after-stall report: {after:?}")),
    }
    let who = if by_cli { "cli" } else { "guard" };
    run.finish("stalled", format!("k={k} by={who} delay={delay}"))
}

fn parse_after(line: &str) -> Option<(u32, u32, u32)> {
    let mut values = line
        .split_whitespace()
        .skip(1)
        .map(|kv| kv.split_once('=').and_then(|(_, v)| v.parse::<u32>().ok()));
    Some((values.next()??, values.next()??, values.next()??))
}

/// The installer runs the CLI before an update while the host is healthy: the host answers with
/// the update's restore, which shows everything and keeps positions, and its guard ends.
fn update_answered(exes: &Exes, label: &str, rng: &mut Rng) -> Outcome {
    let mut run = Run::start(exes, label, &normal_args());
    let k = rng.below(run.plan as u64 + 1) as usize;
    run.reach(k);
    run.cli_update(5_000);
    match run.next(|l| l.starts_with("restored ")) {
        Some(line) => run.check_restored(&line),
        None => run
            .problems
            .push("the host didn't answer the update".into()),
    }
    run.finish("update answered", format!("k={k}"))
}

/// Someone runs the CLI while the host is healthy: the host answers and restores, and its guard
/// ends without writing.
fn answered(exes: &Exes, label: &str, rng: &mut Rng) -> Outcome {
    let mut run = Run::start(exes, label, &normal_args());
    let k = rng.below(run.plan as u64 + 1) as usize;
    run.reach(k);
    run.cli(5_000);
    match run.next(|l| l.starts_with("restored ")) {
        Some(line) => run.check_restored(&line),
        None => run.problems.push("the host didn't answer the CLI".into()),
    }
    run.finish("cli answered", format!("k={k}"))
}
