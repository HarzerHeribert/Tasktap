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
}

/// Every agent a shim is named after.
const RULES: &[&Rules] = &[
    &super::codex::RULES,
    &super::claude::RULES,
    &super::antigravity::RULES,
    &super::pi::RULES,
    &super::opencode::RULES,
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
    "--plugin-dir", "--workspace", "-H", "--header", "--endpoint", "--worktree-base",
];

impl Rules {
    /// Whether a person will type to this run; the terminal is checked apart.
    pub fn interactive(&self, args: &[String]) -> bool {
        let flagged = |flags: &[&str], arg: &str| {
            (flags.iter()).any(|f| arg == *f || (f.ends_with('=') && arg.starts_with(f)))
        };
        if (args.iter()).any(|a| flagged(NONINTERACTIVE, a) || flagged(self.noninteractive, a)) {
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
                return !self.passthrough.contains(&arg.as_str());
            }
        }
        true
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
