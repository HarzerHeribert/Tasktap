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
    "--print-timeout", "--prompt-interactive", "-i",
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
    RULES.iter().copied().find(|rules| rules.agent == name)
}

/// The agents a shim is named after.
pub fn shimmed() -> impl Iterator<Item = &'static str> {
    RULES.iter().map(|rules| rules.agent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(agent: &str) -> &'static Rules {
        named(OsStr::new(agent)).unwrap()
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
        for agent in ["pi", "opencode", "cursor"] {
            assert!(named(OsStr::new(agent)).is_none(), "{agent}");
        }
        for agent in shimmed() {
            assert!(crate::agents::find(agent).is_some(), "{agent}");
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
        ] {
            assert_eq!(
                rules(agent).approval(&words(args)),
                added,
                "{agent} {args:?}"
            );
        }
    }
}
