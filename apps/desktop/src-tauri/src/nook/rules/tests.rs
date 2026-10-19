// The rules' tests: matching, precedence, the owner's rules.json, and the shipped defaults.

use super::*;

fn known<'a>(
    class: &'a str,
    exe: Option<&'a str>,
    title: &'a mut dyn FnMut() -> Option<String>,
) -> Known<'a> {
    Known {
        class,
        exe,
        path: exe,
        title,
    }
}

#[test]
fn every_default_rule_compiles_and_keeps_its_source() {
    let all = parse_default(DEFAULT);
    assert!(all.len() > 150, "{} rules", all.len());
    for r in &all {
        assert!(r.is_ok(), "{r:?}");
    }
    let source: serde_json::Value = serde_json::from_str(DEFAULT).unwrap();
    let source = &source["source"];
    assert_eq!(source["copyright"], "Copyright (c) 2024 Jade Iqbal");
    assert_eq!(source["license"], "MIT");
    assert_eq!(
        source["commit"].as_str().map(str::len),
        Some(40),
        "the commit is recorded"
    );
    assert!(source["license_text"]
        .as_str()
        .unwrap()
        .contains("Permission is hereby granted"));
}

#[test]
fn nooks_own_entries_come_before_the_translated_ones() {
    let d = defaults();
    let first_komorebi = d.iter().position(|r| r.origin == Origin::Komorebi).unwrap();
    assert!(d[..first_komorebi].iter().all(|r| r.origin == Origin::Nook));
    assert!(d[first_komorebi..]
        .iter()
        .all(|r| r.origin == Origin::Komorebi));
    let discord = d.iter().find(|r| r.app == "Discord").unwrap();
    assert_eq!(discord.action, Action::Float);
    assert_eq!(discord.flags, vec![Flag::NoHide]);
}

#[test]
fn a_dialog_floats_by_class_without_the_process() {
    let rules = Rules {
        default: defaults().iter().collect(),
        ..Rules::default()
    };
    let mut no_title = || None;
    let found = rules.first(&mut known("#32770", None, &mut no_title));
    assert!(matches!(found, Lookup::Found(r) if r.action == Action::Float && r.app == "Dialogs"));
}

#[test]
fn a_rule_naming_the_exe_waits_for_the_process() {
    let rules = Rules {
        default: defaults().iter().collect(),
        ..Rules::default()
    };
    let mut no_title = || None;
    let lookup = rules.first(&mut known("Chrome_WidgetWin_1", None, &mut no_title));
    assert_eq!(lookup, Lookup::NeedsProcess);
    let mut no_title = || None;
    let lookup = rules.first(&mut known(
        "Chrome_WidgetWin_1",
        Some("chrome.exe"),
        &mut no_title,
    ));
    assert_eq!(lookup, Lookup::None);
    let mut no_title = || None;
    let lookup = rules.first(&mut known(
        "Chrome_WidgetWin_1",
        Some("DISCORD.EXE"),
        &mut no_title,
    ));
    assert!(matches!(lookup, Lookup::Found(r) if r.app == "Discord"));
}

#[test]
fn the_owners_rules_win_over_the_defaults() {
    let mut rules = Rules {
        default: defaults().iter().collect(),
        ..Rules::default()
    };
    rules.add_user(r#"[{"match": {"exe": "Discord.exe"}, "action": "manage"}]"#);
    assert!(rules.problems.is_empty(), "{:?}", rules.problems);
    let mut no_title = || None;
    let lookup = rules.first(&mut known(
        "Chrome_WidgetWin_1",
        Some("discord.exe"),
        &mut no_title,
    ));
    assert!(
        matches!(lookup, Lookup::Found(r) if r.origin == Origin::User && r.action == Action::Manage)
    );
}

#[test]
fn the_title_is_read_only_when_the_rest_matched() {
    let mut rules = Rules::default();
    rules.add_user(
        r#"{"rules": [{"match": {"class": "Foo", "title_regex": "^Bar$"}, "action": "ignore"}]}"#,
    );
    let mut reads = 0;
    let mut title = || {
        reads += 1;
        Some("Bar".to_string())
    };
    assert_eq!(
        rules.first(&mut known("Other", None, &mut title)),
        Lookup::None
    );
    assert!(matches!(
        rules.first(&mut known("foo", None, &mut title)),
        Lookup::Found(_)
    ));
    assert_eq!(reads, 1);
}

#[test]
fn bad_rules_are_left_out_with_a_reason() {
    let mut rules = Rules::default();
    rules.add_user(
        r#"[{"match": {"title_regex": "x"}, "action": "ignore"},
            {"match": {"class_regex": "("}, "action": "ignore"},
            {"match": {"exe": "a.exe"}, "action": "sometimes"},
            {"match": {"exe": "b.exe", "colour": "red"}, "action": "float"},
            {"match": {"exe": "ok.exe"}, "action": "float"}]"#,
    );
    assert_eq!(rules.user.len(), 1);
    assert_eq!(rules.problems.len(), 4, "{:?}", rules.problems);
    let mut broken = Rules::default();
    broken.add_user("not json");
    assert_eq!(broken.problems.len(), 1);
}

#[test]
fn a_missing_rules_file_is_no_problem() {
    let tmp = tempfile::tempdir().unwrap();
    let rules = Rules::load(tmp.path());
    assert!(rules.user.is_empty() && rules.problems.is_empty());
    assert!(!rules.default.is_empty());
}
