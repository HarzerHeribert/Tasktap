//! What the shim (design §4) knows about each agent a person may type in a
//! Tasktap shell: when to step aside, and which approval policy to add.
//! The rules are those of `scripts/tasktap_shell.py`, carried over as they
//! were. The adapters keep their own and add the same default policy to the
//! runs the core launches. Only an agent with an adapter has a shim: one
//! without runs as typed, with no shim on its way; its adapter brings its
//! rules when it is built.

use std::ffi::OsStr;
use std::path::Path;

/// What `scripts/tasktap_shell.py` knew about one agent.
pub struct Rules {
    pub agent: &'static str,
    /// Subcommands that run without a session.
    pub passthrough: &'static [&'static str],
    /// Flags, besides [`NONINTERACTIVE`], that mean no one types to it; one
    /// ending in `=` is a prefix.
    pub noninteractive: &'static [&'static str],
    /// Flags and settings that state the person's own approval policy.
    pub policy: &'static [&'static str],
    /// The policy added when the person stated none.
    pub default: &'static [&'static str],
    /// Flags, and words, that set what a run Tasktap starts sets itself: a
    /// session it names or continues, the file its hooks are in, where its
    /// task goes, its folder, its model. The person's command for the agent
    /// may not hold them (`agents::judge`); typed in a shell they are the
    /// person's own.
    pub taken: &'static [&'static str],
}

/// Every agent a shim is named after.
const RULES: &[&Rules] = &[
    &super::codex::RULES,
    &super::claude::RULES,
    &super::antigravity::RULES,
    &super::pi::RULES,
    &super::opencode::RULES,
    &super::copilot::RULES,
    #[cfg(feature = "fixtures")]
    &FIXTURE,
];

#[cfg(feature = "fixtures")]
const FIXTURE: Rules = Rules {
    agent: crate::roles::fixture::AGENT,
    passthrough: &["help"],
    noninteractive: &[],
    policy: &["--approve", "--no-approve"],
    default: &["--approve"],
    taken: &["--hook"],
};

/// Flags after which no one types to any agent.
#[rustfmt::skip]
const NONINTERACTIVE: &[&str] = &[
    "-h", "--help", "-V", "--version", "--print", "--remote", "--remote=", "--json", "--rpc",
];

/// Options whose value is the next argument, of any agent.
#[rustfmt::skip]
const VALUE_OPTIONS: &[&str] = &[
    "-c", "--config", "-m", "--model", "-p", "--profile", "-s", "--sandbox", "-C", "--cd",
    "--add-dir", "-a", "--ask-for-approval", "--provider", "--api-key", "--permission-mode",
    "--settings", "--session-id", "--resume", "--agent", "--format", "--output-format",
    "--input-format", "-e", "--extension", "--thinking", "--remote", "--remote-auth-token-env",
    "--conversation", "--effort", "--mode", "--project", "--log-file", "--json-schema",
    "--print-timeout", "--prompt-interactive", "-i", "--session", "--fork", "--session-dir", "--name",
    "-n", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--system-prompt",
    "--append-system-prompt", "--skill", "--prompt-template", "--theme", "--use-theme", "--tui-mode",
    "--server", "--prompt", "--log-level",
    "--plugin-dir", "--workspace", "-H", "--header", "--endpoint", "--worktree-base", "--log-dir",
    "--reasoning-effort", "--context", "--max-ai-credits", "--max-autopilot-continues", "--stream",
    "--usage-output-file", "--attachment", "--additional-mcp-config", "--disable-mcp-server",
    "--enable-mcp-server", "--extension-sdk-path", "--auto-tier", "--dynamic-retrieval",
    "--mcp-github-auth", "--add-github-mcp-tool", "--add-github-mcp-toolset",
];

/// The flag of `flags` that `arg` is, as a start typed in a shell is read:
/// the flag itself, or one ending in `=` that begins it, named without it.
fn typed(flags: &[&str], arg: &str) -> Option<String> {
    let named = |f: &&&str| arg == **f || (f.ends_with('=') && arg.starts_with(**f));
    flags
        .iter()
        .find(named)
        .map(|f| f.trim_end_matches('=').to_owned())
}

/// The flag of `flags` that `arg` gives, as the person's command for an
/// agent is judged when it is kept: as typed, and also a long flag with
/// `=value`, a short one with a value attached (`-C/tmp`, `-C=/tmp`) where
/// it takes one, and short flags given together (`-pc`) where each is one
/// of `known`, the agent's. Anything else is no flag of `flags`.
pub fn at_save(flags: &[&str], known: &[&str], arg: &str) -> Option<String> {
    let valued = |f: &&&str| {
        f.starts_with("--") && arg.strip_prefix(**f).is_some_and(|v| v.starts_with('='))
    };
    if let Some(flag) =
        typed(flags, arg).or_else(|| flags.iter().find(valued).map(|f| (*f).to_owned()))
    {
        return Some(flag);
    }
    let shorts = arg
        .strip_prefix('-')
        .filter(|s| s.len() > 1 && !s.starts_with('-'))?;
    let all: Vec<String> = shorts.chars().map(|c| format!("-{c}")).collect();
    if VALUE_OPTIONS.contains(&all[0].as_str()) {
        return flags.contains(&all[0].as_str()).then(|| all[0].clone());
    }
    let one = |f: &String| f.len() == 2 && known.contains(&f.as_str());
    match all.iter().all(one) {
        true => all.into_iter().find(|f| flags.contains(&f.as_str())),
        false => None,
    }
}

/// The short flags among `lists`, one letter each: the ones an agent is
/// known to have.
pub fn shorts<'a>(lists: &[&[&'a str]]) -> Vec<&'a str> {
    let short =
        |f: &&str| f.len() == 2 && f.starts_with('-') && f.as_bytes()[1].is_ascii_alphabetic();
    lists
        .iter()
        .flat_map(|list| list.iter().copied())
        .filter(short)
        .collect()
}

impl Rules {
    /// Whether a person will type to this run; the terminal is checked apart.
    pub fn interactive(&self, args: &[String]) -> bool {
        self.untyped(args, typed).is_none()
    }

    /// What in `args` makes a run nobody types to, with its flags read by
    /// `read`: a flag that says so, of any agent or of this one, or a
    /// subcommand that runs without a session as the first word that is no
    /// flag nor a flag's value.
    fn untyped(
        &self,
        args: &[String],
        read: impl Fn(&[&str], &str) -> Option<String>,
    ) -> Option<String> {
        let flagged = |a: &String| read(NONINTERACTIVE, a).or_else(|| read(self.noninteractive, a));
        if let Some(flag) = args.iter().find_map(flagged) {
            return Some(flag);
        }
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            if arg == "--" {
                return None;
            }
            if VALUE_OPTIONS.contains(&arg.as_str()) {
                args.next();
            } else if !arg.starts_with('-') {
                return self
                    .passthrough
                    .contains(&arg.as_str())
                    .then(|| arg.clone());
            }
        }
        None
    }

    /// What in the person's own arguments of their command for this agent
    /// sets what a run Tasktap starts sets itself, read as it is kept
    /// ([`at_save`]): what makes nobody type to it, or one of
    /// [`Rules::taken`]. A start typed in a shell is read as before.
    pub fn refused(&self, args: &[String]) -> Option<String> {
        let lists = [NONINTERACTIVE, self.noninteractive, self.policy, self.taken];
        let known = shorts(&lists);
        let read = |flags: &[&str], arg: &str| at_save(flags, &known, arg);
        let taken = |a: &String| read(self.taken, a);
        self.untyped(args, read)
            .or_else(|| args.iter().find_map(taken))
    }

    /// The default approval policy, unless the person stated one.
    pub fn approval(&self, args: &[String]) -> &'static [&'static str] {
        let own = args.iter().any(|arg| {
            let name = arg.split_once('=').map_or(arg.as_str(), |(name, _)| name);
            (self.policy.iter()).any(|p| *p == name || (p.ends_with('=') && arg.starts_with(p)))
        });
        if own { &[] } else { self.default }
    }
}

/// The rules of the agent named `agent`, whether or not it runs here.
pub fn of(agent: &str) -> Option<&'static Rules> {
    RULES.iter().copied().find(|rules| rules.agent == agent)
}

/// The rules of the shim this program is, when it is named after an agent.
pub fn named(program: &OsStr) -> Option<&'static Rules> {
    let name = Path::new(program).file_stem()?.to_str()?;
    supported().find(|rules| rules.agent == name)
}

/// The rules of the agents that run on this system.
fn supported() -> impl Iterator<Item = &'static Rules> {
    let runs = |rules: &&Rules| super::find(rules.agent).is_some_and(|a| a.supported());
    RULES.iter().copied().filter(runs)
}

/// The agents a shim is named after.
pub fn shimmed() -> impl Iterator<Item = &'static str> {
    supported().map(|rules| rules.agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An agent's rules, whether or not it runs on this system.
    fn rules(agent: &str) -> &'static Rules {
        // Cursor is not offered yet (design §7); its rules are kept and tested.
        let all = RULES.iter().copied().chain([&super::super::cursor::RULES]);
        all.into_iter().find(|r| r.agent == agent).unwrap()
    }

    fn words(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn who_types_follows_the_old_shell() {
        for (agent, args, typed) in [
            ("claude", &[][..], true),
            ("claude", &["fix", "the", "bug"], true),
            ("claude", &["-p", "hi"], false),
            ("claude", &["--print"], false),
            ("claude", &["--model", "opus", "mcp"], false),
            ("claude", &["--model", "mcp"], true),
            ("claude", &["--", "mcp"], true),
            ("claude", &["--resume", "abc"], true),
            ("claude", &["--remote=x"], false),
            ("codex", &["exec", "x"], false),
            ("codex", &["-c", "model=o3", "resume"], true),
            ("codex", &["-p", "work"], true),
            ("codex", &["--json"], false),
            ("agy", &[], true),
            ("agy", &["-i", "fix the bug"], true),
            ("agy", &["--conversation", "abc"], true),
            ("agy", &["-p", "hi"], false),
            ("agy", &["--prompt", "hi"], false),
            ("agy", &["models"], false),
            ("agy", &["--model", "gemini-4-carbon-low", "acp"], false),
            ("agy", &["--model", "models"], true),
            ("pi", &[], true),
            ("pi", &["fix the bug"], true),
            ("pi", &["--session", "abc", "go on"], true),
            (
                "pi",
                &[
                    "--model",
                    "deepseek/deepseek-flash",
                    "--tools",
                    "read,ls",
                    "list",
                ],
                false,
            ),
            ("pi", &["--name", "list"], true),
            ("pi", &["-p", "hi"], false),
            ("pi", &["--mode", "json", "hi"], false),
            ("pi", &["--list-models"], false),
            ("pi", &["-v"], false),
            ("pi", &["auth", "login", "deepseek"], false),
            ("pi", &["-e", "x.ts", "install", "npm:x"], false),
            ("pi", &["--", "update"], true),
            ("opencode", &[], true),
            ("opencode", &["--prompt", "fix the bug"], true),
            ("opencode", &["--session", "ses_1", "--standalone"], true),
            ("opencode", &["some/folder"], true),
            (
                "opencode",
                &["--server", "http://127.0.0.1:4096", "run", "hi"],
                false,
            ),
            ("opencode", &["run", "hi"], false),
            ("opencode", &["auth", "list"], false),
            ("opencode", &["--log-level", "debug", "serve"], false),
            ("opencode", &["mini"], false),
            ("opencode", &["-v"], false),
            ("opencode", &["--completions", "zsh"], false),
            ("copilot", &[], true),
            ("copilot", &["-i", "fix the bug"], true),
            ("copilot", &["--resume=abc", "--plugin-dir", "/x"], true),
            (
                "copilot",
                &["--model", "gpt-5.4-mini", "--log-dir", "/x", "login"],
                false,
            ),
            ("copilot", &["-p", "hi"], false),
            ("copilot", &["--prompt=hi"], false),
            ("copilot", &["--acp"], false),
            ("copilot", &["-v"], false),
            ("copilot", &["plugin", "list"], false),
            ("copilot", &["sessions"], false),
            ("cursor-agent", &[], true),
            ("cursor-agent", &["fix", "the", "bug"], true),
            ("cursor-agent", &["--resume", "abc"], true),
            ("cursor-agent", &["--plugin-dir", "/x", "ls"], true),
            ("cursor-agent", &["agent", "fix it"], true),
            ("cursor-agent", &["--workspace", "mcp"], true),
            ("cursor-agent", &["-p", "hi"], false),
            ("cursor-agent", &["--list-models"], false),
            ("cursor-agent", &["-v"], false),
            ("cursor-agent", &["status"], false),
            ("cursor-agent", &["--model", "auto", "login"], false),
            ("cursor-agent", &["--plugin-dir", "/x", "update"], false),
        ] {
            assert_eq!(
                rules(agent).interactive(&words(args)),
                typed,
                "{agent} {args:?}"
            );
        }
    }

    /// How a start typed in a shell was read at d4505ca, before the person's
    /// command for an agent was judged with flags given together.
    fn before(rules: &Rules, args: &[String]) -> bool {
        let flagged = |flags: &[&str], arg: &str| {
            (flags.iter()).any(|f| arg == *f || (f.ends_with('=') && arg.starts_with(f)))
        };
        if (args.iter()).any(|a| flagged(NONINTERACTIVE, a) || flagged(rules.noninteractive, a)) {
            return false;
        }
        let mut args = args.iter();
        while let Some(arg) = args.next() {
            if arg == "--" {
                return true;
            }
            if VALUE_OPTIONS.contains(&arg.as_str()) {
                args.next();
            } else if !arg.starts_with('-') {
                return !rules.passthrough.contains(&arg.as_str());
            }
        }
        true
    }

    #[test]
    fn a_start_typed_in_a_shell_is_read_as_it_was() {
        #[rustfmt::skip]
        let cases: &[&[&str]] = &[
            &["-dhooks"], &["-pc"], &["-cp"], &["-rabc"], &["-C/tmp/x"], &["-C=/tmp/x"], &["-p"],
            &["--print=x"], &["--remote=x"], &["-hV"], &["-Vh"], &["-ph"], &["e"], &["review"],
            &["--model", "opus", "mcp"], &["-c", "model=o3", "resume"], &["--", "-p"], &["-pwork"],
            &["--json"], &["--help"], &["-i", "fix the bug"], &["--prompt=hi"], &["-vfoo"],
        ];
        let all = RULES.iter().copied().chain([&super::super::cursor::RULES]);
        for rules in all {
            for args in cases {
                let args = words(args);
                assert_eq!(
                    rules.interactive(&args),
                    before(rules, &args),
                    "{} {args:?}",
                    rules.agent
                );
            }
        }
    }

    #[test]
    fn only_an_agent_with_an_adapter_has_a_shim() {
        for agent in ["cursor-agent", "aider"] {
            assert!(named(OsStr::new(agent)).is_none(), "{agent}");
        }
        for agent in shimmed() {
            assert!(crate::agents::find(agent).is_some(), "{agent}");
        }
        // Nor has one that does not run on this system yet: typed there, it
        // runs as typed.
        for rules in RULES {
            let runs = crate::agents::find(rules.agent).unwrap().supported();
            assert_eq!(
                named(OsStr::new(rules.agent)).is_some(),
                runs,
                "{}",
                rules.agent
            );
        }
    }

    #[test]
    fn the_default_policy_is_added_only_without_ones_own() {
        for (agent, args, added) in [
            ("claude", &[][..], &["--permission-mode", "auto"][..]),
            ("claude", &["--permission-mode=plan"], &[]),
            ("claude", &["--dangerously-skip-permissions"], &[]),
            ("codex", &[], &["--approve-for-me"]),
            ("codex", &["-c", "approval_policy=never"], &[]),
            ("codex", &["--sandbox=read-only"], &[]),
            // Antigravity keeps the mode the person set: none is added.
            ("agy", &[], &[]),
            ("agy", &["--mode", "plan"], &[]),
            // Pi asks for no approval: there is none to add.
            ("pi", &[], &[]),
            ("pi", &["--approve"], &[]),
            // OpenCode keeps the permissions the person configured.
            ("opencode", &[], &[]),
            ("opencode", &["--auto"], &[]),
            // So does Copilot.
            ("copilot", &[], &[]),
            ("copilot", &["--yolo"], &[]),
            // So does Cursor.
            ("cursor-agent", &[], &[]),
            ("cursor-agent", &["--yolo"], &[]),
        ] {
            assert_eq!(
                rules(agent).approval(&words(args)),
                added,
                "{agent} {args:?}"
            );
        }
    }
}
