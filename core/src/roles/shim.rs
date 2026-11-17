//! The shim (design §4): this program named after an agent, in the shim
//! folder a Tasktap shell puts first on its PATH. When a person types the
//! agent's name it finds the real agent and either steps aside, running it
//! untouched, or adopts it: the core makes it a session of the shell's
//! terminal, and the shim runs it as its child with its hooks attached,
//! waits, restores the terminal and reports the exit, since the core is the
//! parent of the shell only. Until the agent exits it answers `shim.hold`.
//!
//! The rules of when to step aside and which approval policy to add are
//! those of `scripts/tasktap_shell.py`, carried over as they were.

use std::ffi::{OsStr, OsString};
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError, mpsc};
use std::time::Instant;

use tasktap_proto::call::{self, Call, Code, Error};
use tasktap_proto::{Adopt, Control, Event, Frame, Outcome, Reply, SessionEvent, Uuid};

use super::{Bound, FAILED, Fail, SOCKET, TOKEN, WAIT};
use crate::agents::{self, Agent};
use crate::client::Client;
use crate::sys;

/// The shim folder of a data folder: `<data>/shims`.
pub const SHIMS: &str = "shims";

/// What `scripts/tasktap_shell.py` knew about one agent.
pub struct Rules {
    pub agent: &'static str,
    /// Subcommands that run without a session.
    passthrough: &'static [&'static str],
    /// Flags, besides [`NONINTERACTIVE`], that mean no one types to it; one
    /// ending in `=` is a prefix.
    noninteractive: &'static [&'static str],
    /// Flags and settings that state the person's own approval policy.
    policy: &'static [&'static str],
    /// The policy added when the person stated none.
    default: &'static [&'static str],
}

#[rustfmt::skip]
const RULES: &[Rules] = &[
    Rules {
        agent: "codex",
        passthrough: &["agents", "exec", "e", "review", "login", "logout", "mcp", "plugin",
            "app-server", "remote-control", "app", "completion", "update", "doctor", "sandbox",
            "debug", "apply", "queue", "archive", "delete", "migrate-rollouts", "migrate-nfs-db",
            "unarchive", "cloud", "exec-server", "features", "help"],
        noninteractive: &[],
        // Settings given with `-c` are the last three, prefixes of any argument.
        policy: &["--approve-for-me", "--ask-for-approval", "-a",
            "--dangerously-bypass-approvals-and-sandbox", "--sandbox", "-s",
            "approval_policy=", "approvals_reviewer=", "sandbox_mode="],
        default: &["--approve-for-me"],
    },
    Rules {
        agent: "claude",
        passthrough: &["auth", "doctor", "install", "mcp", "plugin", "plugins", "setup-token",
            "update", "upgrade", "help"],
        noninteractive: &["-p"],
        policy: &["--permission-mode", "--dangerously-skip-permissions", "--permission-prompt-tool"],
        default: &["--permission-mode", "auto"],
    },
    Rules {
        agent: "opencode",
        passthrough: &["acp", "auth", "bench", "completion", "db", "debug", "export", "import",
            "mcp", "models", "pr", "run", "serve", "session", "stats", "uninstall", "upgrade",
            "web", "help"],
        noninteractive: &[],
        policy: &["--auto"],
        default: &["--auto"],
    },
    Rules {
        agent: "pi",
        passthrough: &["install", "remove", "update", "list", "config"],
        noninteractive: &["-p", "--mode", "--mode="],
        policy: &["--approve", "-a", "--no-approve", "-na"],
        default: &["--approve"],
    },
    #[cfg(feature = "fixtures")]
    Rules {
        agent: super::fixture::AGENT,
        passthrough: &["help"],
        noninteractive: &[],
        policy: &["--approve", "--no-approve"],
        default: &["--approve"],
    },
];

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
];

impl Rules {
    /// Whether a person will type to this run; the terminal is checked apart.
    fn interactive(&self, args: &[String]) -> bool {
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
    fn approval(&self, args: &[String]) -> &'static [&'static str] {
        let own = args.iter().any(|arg| {
            let name = arg.split_once('=').map_or(arg.as_str(), |(name, _)| name);
            (self.policy.iter()).any(|p| *p == name || (p.ends_with('=') && arg.starts_with(p)))
        });
        if own { &[] } else { self.default }
    }
}

/// The shim this program is, when it is named after an agent.
pub fn named(program: &OsStr) -> Option<&'static Rules> {
    let name = Path::new(program).file_stem()?.to_str()?;
    RULES.iter().find(|rules| rules.agent == name)
}

/// Makes `<data>/shims` hold this program under each agent's name and as
/// `tasktap`, which hooks and `tasktap ask` run; a link where the system
/// allows one. The core's shells put the folder first on their PATH.
pub fn install(data: &Path, exe: &Path) -> io::Result<PathBuf> {
    let folder = data.join(SHIMS);
    std::fs::create_dir_all(&folder)?;
    for name in RULES.iter().map(|rules| rules.agent).chain(["tasktap"]) {
        let shim = folder
            .join(name)
            .with_extension(std::env::consts::EXE_EXTENSION);
        match std::fs::remove_file(&shim) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        if std::fs::hard_link(exe, &shim).is_err() {
            std::fs::copy(exe, &shim)?;
        }
    }
    Ok(folder)
}

pub fn run(rules: &'static Rules, args: Vec<OsString>) -> ExitCode {
    #[cfg(feature = "fixtures")]
    if rules.agent == super::fixture::AGENT && std::env::var_os(super::fixture::REAL).is_some() {
        return super::fixture::run(args);
    }
    let Some(real) = real(rules.agent) else {
        let _ = writeln!(
            io::stderr(),
            "tasktap: {} is not installed on this shell's PATH",
            rules.agent
        );
        return ExitCode::from(127);
    };
    let words: Vec<String> = (args.iter())
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let observed = agents::find(rules.agent)
        .filter(|_| terminal() && std::env::var_os(TOKEN).is_some() && rules.interactive(&words));
    let Some(agent) = observed else {
        return pass(&real, args);
    };
    // A core that does not answer never keeps the person from their agent.
    let (adopted, waited) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = adopted.send(adopt(agent));
    });
    let adopted = waited.recv_timeout(WAIT).unwrap_or_else(|_| {
        let why = format!("the core did not answer within {} s", WAIT.as_secs());
        Err(Some(Fail(FAILED, why)))
    });
    match adopted {
        Ok(link) => observe(agent, rules, &real, args, &words, link),
        // The terminal has an observed agent already: this one runs inside it.
        Err(None) => pass(&real, args),
        Err(Some(Fail(_, why))) => {
            let _ = writeln!(
                io::stderr(),
                "tasktap: {} runs unobserved: {why}",
                rules.agent
            );
            pass(&real, args)
        }
    }
}

/// Standard input and output are a terminal a person types in.
fn terminal() -> bool {
    #[cfg(feature = "fixtures")]
    if std::env::var_os(super::fixture::TTY).is_some() {
        return true;
    }
    io::stdin().is_terminal() && io::stdout().is_terminal()
}

/// The agent's own executable: the first on the PATH that is no shim. The
/// shim folder of the core this shell belongs to is skipped, and so is any
/// file that is this program.
fn real(name: &str) -> Option<PathBuf> {
    let me = std::env::current_exe().ok();
    let shims = std::env::var_os(SOCKET)
        .and_then(|socket| Some(Path::new(&socket).parent()?.join(SHIMS)))
        .and_then(|shims| std::fs::canonicalize(shims).ok());
    for folder in std::env::split_paths(&std::env::var_os("PATH")?) {
        if folder.as_os_str().is_empty()
            || shims.is_some() && std::fs::canonicalize(&folder).ok() == shims
        {
            continue;
        }
        for file in candidates(&folder, name) {
            if runnable(&file) && !me.as_deref().is_some_and(|me| same(me, &file)) {
                return Some(file);
            }
        }
    }
    None
}

#[cfg(unix)]
fn candidates(folder: &Path, name: &str) -> Vec<PathBuf> {
    vec![folder.join(name)]
}

/// Each extension of `PATHEXT`, as the command prompt tries them.
#[cfg(windows)]
fn candidates(folder: &Path, name: &str) -> Vec<PathBuf> {
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    (exts.split(';').filter(|e| !e.is_empty()))
        .map(|ext| folder.join(format!("{name}{}", ext.to_ascii_lowercase())))
        .collect()
}

#[cfg(unix)]
fn runnable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn runnable(file: &Path) -> bool {
    file.is_file()
}

/// Whether two paths name one file, through any link.
#[cfg(unix)]
fn same(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (std::fs::metadata(a), std::fs::metadata(b)) {
        (Ok(a), Ok(b)) => (a.dev(), a.ino()) == (b.dev(), b.ino()),
        _ => false,
    }
}

/// A hard link is not told apart here; the shim folder is skipped by name.
#[cfg(windows)]
fn same(a: &Path, b: &Path) -> bool {
    std::fs::canonicalize(a).ok() == std::fs::canonicalize(b).ok()
}

/// Runs the real agent untouched, as if the shim were not there.
fn pass(real: &Path, args: Vec<OsString>) -> ExitCode {
    let mut agent = Command::new(real);
    agent.args(args);
    #[cfg(feature = "fixtures")]
    agent.env(super::fixture::REAL, "1");
    #[cfg(unix)]
    {
        let e = std::os::unix::process::CommandExt::exec(&mut agent);
        let _ = writeln!(
            io::stderr(),
            "tasktap: {} could not run: {e}",
            real.display()
        );
        ExitCode::from(126)
    }
    // No exec: the shim waits and passes the exit on.
    #[cfg(windows)]
    match agent.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(1)),
        Err(e) => {
            let _ = writeln!(
                io::stderr(),
                "tasktap: {} could not run: {e}",
                real.display()
            );
            ExitCode::from(126)
        }
    }
}

/// `session.adopt` on a connection that offers `shim.hold`. `Err(None)` when
/// the terminal already has a live session.
fn adopt(agent: &'static dyn Agent) -> Result<Client, Option<Fail>> {
    let hold = call::Name::ShimHold.as_str().to_owned();
    let mut link = super::session("shim", vec![hold])?;
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned());
    let adopt = Adopt {
        agent: agent.id().into(),
        cwd: cwd.unwrap_or_default(),
    };
    match link.call::<call::SessionAdopt>(&adopt) {
        Ok(Ok(_)) => Ok(link),
        Ok(Err(e)) if e.code == Code::Conflict => Err(None),
        Ok(Err(e)) => Err(Some(Fail(FAILED, e.message))),
        Err(e) => Err(Some(super::ended(e))),
    }
}

/// Runs the adopted agent as this process's child and returns its exit.
fn observe(
    agent: &dyn Agent,
    rules: &Rules,
    real: &Path,
    args: Vec<OsString>,
    words: &[String],
    link: Client,
) -> ExitCode {
    let exe = super::program().unwrap_or_else(|_| "tasktap".into());
    let mut run = Command::new(real);
    run.args(agent.attach(&exe))
        .args(rules.approval(words))
        .args(args);
    #[cfg(feature = "fixtures")]
    run.env(super::fixture::REAL, "1");
    let modes = sys::modes();
    let mut child = match run.spawn() {
        Ok(child) => child,
        // The adopted session ends with this connection.
        Err(e) => {
            let _ = writeln!(
                io::stderr(),
                "tasktap: {} could not run: {e}",
                real.display()
            );
            return ExitCode::from(126);
        }
    };
    let hold = Arc::new(Hold::default());
    let tty = io::stdin().is_terminal();
    std::thread::spawn({
        let hold = hold.clone();
        move || answer(link, &hold, tty)
    });
    let status = {
        let _interrupts = sys::ignore_interrupts();
        child.wait()
    };
    let typed = hold.ended();
    if let Some(modes) = &modes {
        // Leaves the modes a full-screen agent set, without clearing the screen.
        if io::stdout().is_terminal() {
            let _ = io::stdout().write_all(RELEASE);
        }
        // A follow-up the agent never read must not reach the shell.
        sys::restore(modes, typed);
    }
    let code = status.map_or(1, |status| code(&status));
    report(code);
    std::process::exit(code)
}

/// Mouse, focus, paste, keyboard and screen modes off, the cursor shown.
const RELEASE: &[u8] = b"\x1b[?9;1000;1002;1003;1004;1005;1006;1015;1016;2004;2026l\x1b[?1l\x1b>\x1b[<u\x1b[=0u\x1b[>4;0m\x1b[?47l\x1b[0m\x1b[?25h";

#[cfg(unix)]
fn code(status: &std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt;
    status
        .code()
        .unwrap_or_else(|| 128 + status.signal().unwrap_or(0))
}

#[cfg(windows)]
fn code(status: &std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(1)
}

/// Tells the core the agent exited, on a connection of its own: the first is
/// read on another thread, which a Windows pipe does not allow beside a write.
/// If this fails the first connection's end, as the process exits, ends the
/// session all the same.
fn report(code: i32) {
    let _bound = Bound::new(code);
    let exited = SessionEvent {
        id: format!("exited {}", Uuid::now_v7()),
        turn: None,
        subagent: false,
        event: Event::Exited {
            code: u32::try_from(code).ok(),
        },
    };
    let sent = super::session("shim", Vec::new()).and_then(|mut c| super::report(&mut c, &exited));
    if let Err(Fail(_, why)) = sent {
        let _ = writeln!(
            io::stderr(),
            "tasktap: the agent's exit was not reported: {why}"
        );
    }
}

/// Whether the core may type into the terminal, as `shim.hold` asks.
#[derive(Default)]
struct Hold {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    /// The agent has exited.
    ended: bool,
    /// The core is typing a follow-up.
    held: bool,
    /// A follow-up was typed during the agent's run.
    typed: bool,
    /// The connection ended: nothing will be typed any more.
    gone: bool,
}

impl Hold {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, hold: bool, tty: bool) -> Result<(), Error> {
        let mut s = self.state();
        if !hold {
            s.held = false;
            self.changed.notify_all();
        } else if s.ended || tty && !sys::foreground() {
            return Err(Error::new(
                Code::Gone,
                "the agent does not run in the foreground",
            ));
        } else {
            (s.held, s.typed) = (true, true);
        }
        Ok(())
    }

    fn gone(&self) {
        let mut s = self.state();
        (s.gone, s.held) = (true, false);
        self.changed.notify_all();
    }

    /// The agent exited: refuses any hold from now on and waits, within
    /// [`WAIT`], for one under way to end. Whether anything was typed.
    fn ended(&self) -> bool {
        let deadline = Instant::now() + WAIT;
        let mut s = self.state();
        s.ended = true;
        while s.held && !s.gone {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            s = (self.changed.wait_timeout(s, left))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
        s.typed
    }
}

/// Answers the core's calls on the adopting connection until it ends.
fn answer(mut link: Client, hold: &Hold, tty: bool) {
    loop {
        let request = match link.recv() {
            Ok(Frame::Control(Control::Call(request))) => request,
            Ok(_) => continue,
            Err(_) => return hold.gone(),
        };
        let reply = if request.name == call::ShimHold::NAME.as_str() {
            let held = call::ShimHold::args(request.args).and_then(|h| hold.set(h.hold, tty));
            call::ShimHold::reply(request.id, held)
        } else {
            let why = format!("a shim answers no {}", request.name);
            let outcome = Outcome::Err(Error::new(Code::Unknown, why));
            Control::Reply(Reply {
                id: request.id,
                outcome,
            })
        };
        if link.send(&reply).is_err() {
            return hold.gone();
        }
    }
}

/// The cases of `scripts/tasktap_shell.py`'s rules, which need an agent's
/// adapter before a shim acts on them through the binary.
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
            ("pi", &["-p", "x"], false),
            ("pi", &["--mode=rpc"], false),
            ("pi", &["--mode", "rpc"], false),
            ("pi", &["install"], false),
            ("opencode", &["run", "x"], false),
            ("opencode", &["-V"], false),
        ] {
            assert_eq!(
                rules(agent).interactive(&words(args)),
                typed,
                "{agent} {args:?}"
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
            ("pi", &["-na"], &[]),
            ("pi", &["x"], &["--approve"]),
            ("opencode", &[], &["--auto"]),
        ] {
            assert_eq!(
                rules(agent).approval(&words(args)),
                added,
                "{agent} {args:?}"
            );
        }
    }
}
