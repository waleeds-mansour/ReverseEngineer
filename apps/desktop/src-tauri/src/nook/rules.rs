// Per-app rules (docs/nook-wm.md, "PER-APP OVERRIDES"). The owner's rules.json in Nook's folder
// comes first, then rules/default.json: Nook's own entries and a translated subset of
// komorebi-application-specific-configuration (MIT; the source block in that file keeps its
// copyright line and commit). Hard denies come before both, and the heuristics after, which is
// eligibility.rs's business. Rules are compiled once. A rule is tried with the facts known so
// far, so a window that a rule ignores by class alone is decided without opening its process.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::OnceLock;

const DEFAULT: &str = include_str!("rules/default.json");
/// The owner's own rules, in Nook's folder.
pub const USER_FILE: &str = "rules.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Manage,
    Float,
    Ignore,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Flag {
    /// Shown on every workspace and never minimized by Nook: apps that live in the tray.
    NoHide,
    FrameWindowRect,
    NoRing,
    LayeredQuirk,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchSpec {
    pub exe: Option<String>,
    pub exe_regex: Option<String>,
    pub class: Option<String>,
    pub class_regex: Option<String>,
    pub title_regex: Option<String>,
    pub path_prefix: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuleSpec {
    #[serde(default)]
    pub app: Option<String>,
    #[serde(rename = "match")]
    pub when: MatchSpec,
    pub action: Action,
    #[serde(default)]
    pub auto: bool,
    #[serde(default)]
    pub flags: Vec<Flag>,
    #[serde(default)]
    pub from: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    /// The owner's rules.json.
    User,
    /// Nook's own entries in default.json.
    Nook,
    /// The komorebi-asc subset in default.json.
    Komorebi,
}

#[derive(Debug)]
pub struct Rule {
    pub app: String,
    pub action: Action,
    /// Auto mode's list (P2) arranges this app's new windows as they open; P1 only carries it.
    #[allow(dead_code)]
    pub auto: bool,
    pub flags: Vec<Flag>,
    pub origin: Origin,
    exe: Option<String>,
    exe_re: Option<Regex>,
    class: Option<String>,
    class_re: Option<Regex>,
    title_re: Option<Regex>,
    path_prefix: Option<String>,
}

/// What is known about a window when a rule is tried. Process facts are None until Stage C.
pub struct Known<'a> {
    pub class: &'a str,
    pub exe: Option<&'a str>,
    pub path: Option<&'a str>,
    /// Reads the title, once, only if a rule that otherwise matches asks for it.
    pub title: &'a mut dyn FnMut() -> Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Tried {
    Yes,
    No,
    /// The rule names the exe or path, which aren't known yet.
    NeedsProcess,
}

impl Rule {
    fn compile(spec: RuleSpec, origin: Origin) -> Result<Rule, String> {
        let re = |p: &Option<String>| -> Result<Option<Regex>, String> {
            p.as_deref()
                .map(|p| Regex::new(p).map_err(|e| format!("{p}: {e}")))
                .transpose()
        };
        let m = &spec.when;
        // A title alone could be any app's.
        let names_an_app = m.exe.is_some()
            || m.exe_regex.is_some()
            || m.class.is_some()
            || m.class_regex.is_some()
            || m.path_prefix.is_some();
        if !names_an_app {
            return Err("a rule needs an exe, class or path, not a title alone".into());
        }
        Ok(Rule {
            app: spec.app.clone().unwrap_or_default(),
            action: spec.action,
            auto: spec.auto,
            flags: spec.flags.clone(),
            origin,
            exe: m.exe.as_deref().map(str::to_ascii_lowercase),
            exe_re: re(&m.exe_regex)?,
            class: m.class.as_deref().map(str::to_ascii_lowercase),
            class_re: re(&m.class_regex)?,
            title_re: re(&m.title_regex)?,
            path_prefix: m.path_prefix.as_deref().map(str::to_ascii_lowercase),
        })
    }

    /// Cheap conditions first; the title is read last, and only if everything else matched.
    pub fn try_match(&self, known: &mut Known<'_>) -> Tried {
        if let Some(class) = &self.class {
            if !known.class.eq_ignore_ascii_case(class) {
                return Tried::No;
            }
        }
        if let Some(re) = &self.class_re {
            if !re.is_match(known.class) {
                return Tried::No;
            }
        }
        let wants_process =
            self.exe.is_some() || self.exe_re.is_some() || self.path_prefix.is_some();
        if wants_process {
            let (Some(exe), Some(path)) = (known.exe, known.path) else {
                return Tried::NeedsProcess;
            };
            if self
                .exe
                .as_ref()
                .is_some_and(|e| !exe.eq_ignore_ascii_case(e))
                || self.exe_re.as_ref().is_some_and(|re| !re.is_match(exe))
                || self
                    .path_prefix
                    .as_ref()
                    .is_some_and(|p| !path.to_ascii_lowercase().starts_with(p.as_str()))
            {
                return Tried::No;
            }
        }
        if let Some(re) = &self.title_re {
            match (known.title)() {
                Some(title) if re.is_match(&title) => {}
                _ => return Tried::No,
            }
        }
        Tried::Yes
    }
}

#[derive(Debug)]
pub enum Lookup<'r> {
    Found(&'r Rule),
    None,
    /// An earlier rule can't be decided without the process, so later ones can't be either.
    NeedsProcess,
}

/// The same rule, not an equal one: a compiled regex has no equality of its own.
impl PartialEq for Lookup<'_> {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Lookup::Found(a), Lookup::Found(b)) => std::ptr::eq(*a, *b),
            (Lookup::None, Lookup::None) | (Lookup::NeedsProcess, Lookup::NeedsProcess) => true,
            _ => false,
        }
    }
}

#[derive(Debug, Default)]
pub struct Rules {
    pub user: Vec<Rule>,
    pub default: Vec<&'static Rule>,
    /// Why the owner's rules.json, or one of its rules, was left out.
    pub problems: Vec<String>,
}

impl Rules {
    /// The owner's rules from `dir`, then the defaults.
    pub fn load(dir: &Path) -> Rules {
        let mut rules = Rules {
            default: defaults().iter().collect(),
            ..Rules::default()
        };
        match std::fs::read_to_string(dir.join(USER_FILE)) {
            Ok(text) => rules.add_user(&text),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => rules
                .problems
                .push(format!("{USER_FILE} doesn't open: {e}")),
        }
        rules
    }

    /// rules.json is an ordered list, or an object with a "rules" list like default.json.
    pub fn add_user(&mut self, text: &str) {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum File {
            List(Vec<serde_json::Value>),
            Object { rules: Vec<serde_json::Value> },
        }
        let list = match serde_json::from_str::<File>(text) {
            Ok(File::List(l)) | Ok(File::Object { rules: l }) => l,
            Err(e) => {
                self.problems.push(format!("{USER_FILE} doesn't read: {e}"));
                return;
            }
        };
        for (n, value) in list.into_iter().enumerate() {
            let compiled = serde_json::from_value::<RuleSpec>(value)
                .map_err(|e| e.to_string())
                .and_then(|spec| Rule::compile(spec, Origin::User));
            match compiled {
                Ok(rule) => self.user.push(rule),
                Err(e) => self
                    .problems
                    .push(format!("rule {} in {USER_FILE} is left out: {e}", n + 1)),
            }
        }
    }

    /// The first rule that matches, the owner's before the defaults.
    pub fn first(&self, known: &mut Known<'_>) -> Lookup<'_> {
        let all = self.user.iter().chain(self.default.iter().copied());
        for rule in all {
            match rule.try_match(known) {
                Tried::Yes => return Lookup::Found(rule),
                Tried::No => {}
                Tried::NeedsProcess => return Lookup::NeedsProcess,
            }
        }
        Lookup::None
    }
}

/// default.json, compiled once. It is checked by the tests, so a rule in it that doesn't
/// compile is a bug, and is left out rather than taking Nook down.
pub fn defaults() -> &'static [Rule] {
    static RULES: OnceLock<Vec<Rule>> = OnceLock::new();
    RULES.get_or_init(|| {
        parse_default(DEFAULT)
            .into_iter()
            .filter_map(Result::ok)
            .collect()
    })
}

fn parse_default(text: &str) -> Vec<Result<Rule, String>> {
    #[derive(Deserialize)]
    struct File {
        rules: Vec<RuleSpec>,
    }
    let file: File = match serde_json::from_str(text) {
        Ok(f) => f,
        Err(e) => return vec![Err(e.to_string())],
    };
    file.rules
        .into_iter()
        .map(|spec| {
            let origin = match spec.from.as_deref() {
                Some("nook") => Origin::Nook,
                _ => Origin::Komorebi,
            };
            Rule::compile(spec, origin)
        })
        .collect()
}

#[cfg(test)]
mod tests;
