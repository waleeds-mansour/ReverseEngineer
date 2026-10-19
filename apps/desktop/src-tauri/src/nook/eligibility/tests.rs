// The verdict table (docs/nook-wm.md, "Testing"): one row per kind of window on the owner's PC,
// with the staged order checked by counting process opens. A game or shell class must be decided
// without opening anything.

use super::*;
use crate::nook::fake::{app_window, process, FakeProbe, FakeWindow};
use crate::nook::probe::{Closed, Elevation, Own};

const OWN: Own = Own {
    pid: 1,
    elevated: false,
};

fn rules() -> Rules {
    Rules {
        default: crate::nook::rules::defaults().iter().collect(),
        ..Rules::default()
    }
}

fn one(window: FakeWindow, proc: Option<Result<ProcessFacts, Closed>>) -> (Verdict, usize) {
    one_with(window, proc, &rules(), OWN)
}

fn one_with(
    window: FakeWindow,
    proc: Option<Result<ProcessFacts, Closed>>,
    rules: &Rules,
    own: Own,
) -> (Verdict, usize) {
    let mut probe = FakeProbe::default();
    let pid = window.facts.pid;
    probe.add(10, window);
    if let Some(p) = proc {
        probe.proc(pid, p);
    }
    let v = decide(&probe, own, rules, 10, None).expect("a verdict");
    (v, probe.opens())
}

fn at(path: &str) -> Option<Result<ProcessFacts, Closed>> {
    Some(Ok(process(path)))
}

#[test]
fn the_desktop_and_wallpaper_hosts_are_never_eligible_and_never_opened() {
    for class in ["Progman", "WorkerW", "Shell_TrayWnd", "#32768"] {
        let (v, opens) = one(app_window(class, 50), at(r"C:\Windows\explorer.exe"));
        assert_eq!(
            (v.kind, v.stage, opens),
            (Kind::Ignore, Stage::A, 0),
            "{class}"
        );
        assert_eq!(v.why.code(), "shell_class");
    }
    let (v, _) = one(
        app_window("WPEUI", 51),
        at(r"C:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe"),
    );
    assert_eq!((v.kind, v.why.code()), (Kind::Ignore, "shell_exe"));
}

#[test]
fn riot_and_engine_classes_are_ignored_without_opening_the_process() {
    for (class, code) in [
        ("RiotWindowClass", "game_class"),
        ("RCLIENT", "game_class"),
        ("UnityWndClass", "likely_game"),
        ("UnrealWindow", "likely_game"),
    ] {
        let (v, opens) = one(
            app_window(class, 60),
            at(r"C:\Riot Games\League of Legends\League of Legends.exe"),
        );
        assert_eq!(
            (v.kind, v.why.code(), opens),
            (Kind::Ignore, code, 0),
            "{class}"
        );
    }
}

#[test]
fn an_owner_rule_by_class_can_take_a_likely_game_out_but_not_riot() {
    let mut r = rules();
    r.add_user(
        r#"[{"app": "Unity Editor", "match": {"class": "UnityWndClass"}, "action": "manage"},
            {"match": {"class": "RiotWindowClass"}, "action": "manage"}]"#,
    );
    let editor = at(r"C:\Program Files\Unity\Editor\Unity.exe");
    let (v, opens) = one_with(app_window("UnityWndClass", 61), editor, &r, OWN);
    assert_eq!((v.kind, v.why.code(), opens), (Kind::Tile, "user_rule", 1));
    let (v, opens) = one_with(app_window("RiotWindowClass", 62), None, &r, OWN);
    assert_eq!(
        (v.kind, v.why.code(), opens),
        (Kind::Ignore, "game_class", 0)
    );
}

#[test]
fn steam_games_are_ignored_by_their_folder() {
    let (v, opens) = one(
        app_window("SomeEngineWindow", 70),
        at(r"D:\SteamLibrary\steamapps\common\Game\game.exe"),
    );
    assert_eq!(
        (v.kind, v.why.code(), opens),
        (Kind::Ignore, "game_path", 1)
    );
    assert_eq!(
        v.why.text(),
        r"Under \steamapps\common\: games are never touched"
    );
    let (v, _) = one(
        app_window("UnrealWindow", 71),
        at(r"C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"),
    );
    assert_eq!(v.why.code(), "likely_game", "the class decides first");
    let (v, _) = one(
        app_window("Chrome_WidgetWin_1", 72),
        at(r"C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"),
    );
    assert_eq!(
        v.kind,
        Kind::Float,
        "Epic's launcher is not a game: {:?}",
        v.why
    );
}

#[test]
fn browsers_editors_and_terminals_can_be_arranged() {
    for (class, path) in [
        (
            "Chrome_WidgetWin_1",
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        ),
        (
            "Chrome_WidgetWin_1",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        ),
        (
            "Chrome_WidgetWin_1",
            r"C:\Users\o\AppData\Local\Programs\Microsoft VS Code\Code.exe",
        ),
        (
            "CASCADIA_HOSTING_WINDOW_CLASS",
            r"C:\Program Files\WindowsApps\WT\WindowsTerminal.exe",
        ),
        ("CabinetWClass", r"C:\Windows\explorer.exe"),
    ] {
        let (v, opens) = one(app_window(class, 80), at(path));
        assert_eq!(
            (v.kind, v.why.code(), opens),
            (Kind::Tile, "standard", 1),
            "{path}"
        );
    }
}

#[test]
fn explorer_windows_other_than_folders_are_left_alone() {
    let (v, _) = one(
        app_window("OperationStatusWindow", 81),
        at(r"C:\Windows\explorer.exe"),
    );
    assert_eq!(v.why.code(), "explorer_not_folder");
}

#[test]
fn tray_apps_float_and_stay_on_every_workspace() {
    let (v, _) = one(
        app_window("Chrome_WidgetWin_1", 90),
        at(r"C:\Users\o\AppData\Local\Discord\app-1.0\Discord.exe"),
    );
    assert_eq!((v.kind, v.why.code()), (Kind::Float, "default_rule"));
    assert_eq!(v.flags, vec![Flag::NoHide]);
    assert!(v.why.text().contains("lives in the tray"));
}

#[test]
fn elevated_windows_say_why() {
    let mut elevated = process(r"C:\Windows\System32\Taskmgr.exe");
    elevated.elevation = Elevation::Yes;
    let (v, _) = one(
        app_window("TaskManagerWindow", 91),
        Some(Ok(elevated.clone())),
    );
    assert_eq!(
        (v.kind, v.why.text().as_str()),
        (Kind::Ignore, "Elevated: Windows won't let Nook move it")
    );
    elevated.elevation = Elevation::Unknown;
    let (v, _) = one(
        app_window("TaskManagerWindow", 91),
        Some(Ok(elevated.clone())),
    );
    assert_eq!(v.why.code(), "elevation_unknown");
    // An elevated Nook can move them, so the rules decide: Task Manager floats.
    let own = Own {
        pid: 1,
        elevated: true,
    };
    let (v, _) = one_with(
        app_window("TaskManagerWindow", 91),
        Some(Ok(elevated)),
        &rules(),
        own,
    );
    assert_eq!((v.kind, v.why.code()), (Kind::Float, "default_rule"));
}

#[test]
fn dialogs_owned_topmost_and_fixed_windows_float() {
    let chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe";
    let (v, opens) = one(app_window("#32770", 100), at(chrome));
    assert_eq!(
        (v.kind, v.why.code(), opens),
        (Kind::Float, "default_rule", 1)
    );
    let mut owned = app_window("Chrome_WidgetWin_1", 101);
    owned.facts.owner = 77;
    let (v, _) = one(owned, at(chrome));
    assert_eq!(v.why.text(), "Owned by chrome.exe: a dialog, floats");
    let mut top = app_window("Chrome_WidgetWin_1", 102);
    top.facts.ex_style |= WS_EX_TOPMOST;
    assert_eq!(one(top, at(chrome)).0.why.code(), "topmost");
    let mut fixed = app_window("SomeApp", 103);
    fixed.facts.style &= !WS_THICKFRAME;
    assert_eq!(one(fixed, at(r"C:\x\some.exe")).0.why.code(), "fixed_size");
}

#[test]
fn hidden_tool_and_overlay_windows_are_decided_before_the_process() {
    let mut cases: Vec<(FakeWindow, &str)> = Vec::new();
    let mut w = app_window("A", 110);
    w.facts.visible = false;
    cases.push((w, "not_visible"));
    let mut w = app_window("A", 110);
    w.facts.ex_style = WS_EX_TOOLWINDOW;
    cases.push((w, "tool_window"));
    let mut w = app_window("A", 110);
    w.facts.ex_style = WS_EX_LAYERED | WS_EX_TRANSPARENT;
    cases.push((w, "click_through"));
    let mut w = app_window("A", 110);
    w.facts.ex_style = WS_EX_NOACTIVATE;
    cases.push((w, "no_activate"));
    let mut w = app_window("A", 110);
    w.facts.style = WS_POPUP;
    cases.push((w, "bare_popup"));
    let mut w = app_window("A", 110);
    w.facts.rect.right = w.facts.rect.left + 99;
    cases.push((w, "too_small"));
    let mut w = app_window("A", 110);
    w.facts.pid = OWN.pid;
    cases.push((w, "own_process"));
    let mut w = app_window("A", 110);
    w.cloaked = Some(2);
    cases.push((w, "cloaked"));
    let mut w = app_window("A", 110);
    w.cloaked = None;
    cases.push((w, "cloak_unknown"));
    for (window, code) in cases {
        let (v, opens) = one(window, at(r"C:\x\a.exe"));
        assert_eq!((v.kind, v.why.code(), opens), (Kind::Ignore, code, 0));
    }
}

#[test]
fn a_protected_process_and_another_desktop_are_left_alone() {
    let (v, opens) = one(app_window("A", 120), Some(Err(Closed::Denied)));
    assert_eq!((v.why.code(), opens), ("protected", 1));
    let mut probe = FakeProbe::default();
    probe
        .add(10, app_window("A", 121))
        .proc(121, Ok(process(r"C:\x\a.exe")));
    let v = decide(&probe, OWN, &rules(), 10, Some(false)).unwrap();
    assert_eq!((v.stage, v.why.code()), (Stage::D, "other_desktop"));
    let mut probe = FakeProbe::default();
    probe.add(10, app_window("A", 122));
    assert!(
        decide(&probe, OWN, &rules(), 10, None).is_none(),
        "the process is gone"
    );
    assert!(
        decide(&probe, OWN, &rules(), 11, None).is_none(),
        "the window is gone"
    );
}

#[test]
fn a_uwp_frame_is_judged_by_the_app_inside_it() {
    let mut probe = FakeProbe::default();
    let mut frame = app_window("ApplicationFrameWindow", 130);
    frame.uwp_child = Some(131);
    probe
        .add(10, frame)
        .proc(
            130,
            Ok(process(r"C:\Windows\System32\ApplicationFrameHost.exe")),
        )
        .proc(
            131,
            Ok(process(
                r"C:\Program Files\WindowsApps\Calc\CalculatorApp.exe",
            )),
        );
    let v = decide(&probe, OWN, &rules(), 10, None).unwrap();
    assert_eq!(
        (v.kind, v.exe.as_deref()),
        (Kind::Float, Some("CalculatorApp.exe"))
    );
    assert_eq!(probe.opens(), 2);
}

#[test]
fn shell_exes_and_overlays_are_never_touched() {
    for path in [
        r"C:\Windows\SystemApps\ShellExperienceHost\ShellExperienceHost.exe",
        r"C:\Program Files\NVIDIA Corporation\NVIDIA Overlay\NVIDIA Overlay.exe",
        r"C:\Program Files\Riot Vanguard\vgtray.exe",
    ] {
        let (v, _) = one(app_window("Chrome_WidgetWin_1", 140), at(path));
        assert_eq!(
            (v.kind, v.why.code()),
            (Kind::Ignore, "shell_exe"),
            "{path}"
        );
    }
}

#[test]
fn a_title_rule_reads_the_title_only_for_its_own_app() {
    let mut r = Rules::default();
    r.add_user(r#"[{"match": {"exe": "a.exe", "title_regex": "^Picture"}, "action": "float"}]"#);
    let mut probe = FakeProbe::default();
    let mut w = app_window("A", 150);
    w.title = Some("Picture in picture".into());
    probe
        .add(10, w.clone())
        .proc(150, Ok(process(r"C:\x\b.exe")));
    probe.add(11, w).proc(151, Ok(process(r"C:\x\a.exe")));
    probe.windows.get_mut(&11).unwrap().facts.pid = 151;
    assert_eq!(decide(&probe, OWN, &r, 10, None).unwrap().kind, Kind::Tile);
    assert_eq!(probe.titles_read.get(), 0, "b.exe's title is never read");
    assert_eq!(decide(&probe, OWN, &r, 11, None).unwrap().kind, Kind::Float);
    assert_eq!(probe.titles_read.get(), 1);
}
